#!/usr/bin/env node
/**
 * L5（画面の検査）用のテストアカウントを、ローカルの wrangler dev に **API 経由で** 作る。
 *
 *   node scripts/audit_fixtures.mjs                       # http://127.0.0.1:8787
 *   node scripts/audit_fixtures.mjs --base http://127.0.0.1:8787 --json out.json
 *
 * SQL を直に叩かないのは、**その状態が本当に作れるかどうかも検査だから**。
 * 画面をモックすると「作れない状態」を撮ってしまう（検査観点カタログ L5 の方針）。
 *
 * 作るアカウント（学び側のパスワードでの登録とログインの経路はどの配備にも無い。REQ-204）:
 *   audit_new@example.com    登録だけ。進捗ゼロ・履歴ゼロ（＝空状態の見本）
 *   audit_mid@example.com    学習途中。進捗あり／完走1回／**過去問実践を中断したまま**
 *   audit_heavy@example.com  履歴が多い。完走10回以上（模試含む）／進捗多数
 *
 * 入り方は scripts/check_api.py の SsoFake と同じ。この検査が手元の SSO の偽物（まなびばの交換
 * exchangeCode の代役。SSO_FAKE_PORT）を起こして使い捨てコードを発行し、学び側の signInWithCode
 * （POST /api/auth/sso）に渡してトークンを受け取る。学び側の配備には、まなびばの場所（SSO_PORTAL_URL）
 * として SSO_FAKE_URL、共有秘密（SSO_SECRET）として SSO_FAKE_SECRET を与えておく（audit_screens.sh が渡す）。
 *
 * 冪等。すでに居るアカウントは作り直さず、足りない分だけ足す。
 * **既存データは消さない**（DELETE を一切流さない。ローカル D1 には実データが入っている）。
 *
 * 配備が成功の状態（2xx）で中身の無い答えか、期待した欄を持たない答えか、一覧の要素が期待した形でない答えを返したら、用意を続けずに
 * UnreadableAnswer で止まる。直接回したときは、読めなかった問い合わせを理由に持つ断りの形
 * （{"error":{"code":"UPSTREAM_UNAVAILABLE","reason":…}}）を標準出力の最後の行に出して、終了 1 で終える。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

// 断りの種類の名前の出所（ADR-0012）。名前の文字列をここで書かない
const CODE = JSON.parse(readFileSync(new URL('../src/shared/error-codes.json', import.meta.url), 'utf8'))

/** 配備が成功の状態で読めない答え（中身が無いか、期待した欄を持たないか、一覧の要素が期待した形でない）を返したことを表す失敗。message が読めなかった問い合わせの 1 行。 */
export class UnreadableAnswer extends Error {
  constructor(method, path, why) {
    super(`${method} /api${path} が成功の状態で読めない答えを返した（${why}）`)
    this.code = CODE.UPSTREAM_UNAVAILABLE
  }
}

/** 断りの形（契約の ToolError）を 1 行の JSON で返す。 */
export function toolErrorLine(e) {
  return JSON.stringify({ error: { code: e.code, reason: e.message } })
}

const isRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

/**
 * 成功の状態の答え data から欄 key を読む。kind が 'list' なら要素がどれもオブジェクトの配列、'value' なら null・undefined でない値、
 * 'present' なら欄があること（値は null でもよい）を求め、満たさなければ（中身の無い答えを含む）UnreadableAnswer を投げる。
 */
export function fieldOf(data, key, kind, method, path) {
  const v = isRecord(data) ? data[key] : undefined
  const ok = kind === 'list' ? Array.isArray(v) : kind === 'present' ? isRecord(data) && key in data : v !== undefined && v !== null
  if (!ok) throw new UnreadableAnswer(method, path, `${key} が無い`)
  if (kind === 'list' && !v.every(isRecord)) throw new UnreadableAnswer(method, path, `${key} の要素が期待した形でない`)
  return v
}

// 手元の SSO の偽物。audit_screens.sh が学び側の配備にまなびばの場所と共有秘密としてこの値を与える。
// 値はローカルのこの検査専用で、本番の値ではない。ポートは check_api（8791）・check_sso_flow（8790）と分ける。
export const SSO_FAKE_PORT = 8793
export const SSO_FAKE_URL = `http://127.0.0.1:${SSO_FAKE_PORT}`
export const SSO_FAKE_SECRET = 'audit-screens-local-shared-not-a-secret'

export const ACCOUNTS = [
  { key: 'audit_new', email: 'audit_new@example.com', name: '検査 新規' },
  { key: 'audit_mid', email: 'audit_mid@example.com', name: '検査 学習中' },
  { key: 'audit_heavy', email: 'audit_heavy@example.com', name: '検査 履歴多' },
]

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

export async function apiCall(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text.slice(0, 300) }
  }
  if (!res.ok) {
    const err = new Error(`${method} /api${path} → ${res.status}: ${data?.error ?? ''}`)
    err.status = res.status
    err.body = data
    throw err
  }
  return data
}

/**
 * 手元の SSO の偽物を起こす。まなびばの exchangeCode（POST /api/sso/exchange）の形だけを持つ。
 * 使い捨てコードは issue() がこの検査の中で発行し、学び側サーバが共有秘密を添えて換えに来たら
 * 1 回だけ本人のメールと名前に換える。断りの形は契約 exchangeCode の errors の並び
 * （共有秘密 → 入力の形 → コードの状態）。
 */
async function startSsoFake(appKey) {
  const codes = new Map()
  const reply = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length })
    res.end(data)
  }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/sso/exchange') return reply(res, 404, { error: '見つかりません' })
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        body = text ? JSON.parse(text) : {}
      } catch {
        body = null
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.secret !== SSO_FAKE_SECRET) {
        return reply(res, 403, { error: '共有秘密が合いません' })
      }
      const { code, app } = body
      if (typeof code !== 'string' || !code || typeof app !== 'string' || !app) {
        return reply(res, 400, { error: '入力が正しくありません' })
      }
      const held = codes.get(code)
      if (!held || held.used || held.app !== app) return reply(res, 401, { error: 'コードが無効です' })
      held.used = true
      reply(res, 200, { email: held.email, name: held.name })
    })
  })
  await new Promise((ok, ng) => {
    server.once('error', ng)
    server.listen(SSO_FAKE_PORT, '127.0.0.1', ok)
  })
  return {
    /** その本人・この学び宛ての未使用のコードを発行する（まなびばの startSso の代役）。 */
    issue(email, name) {
      const code = randomUUID()
      codes.set(code, { email, name, app: appKey, used: false })
      return code
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  }
}

/** 検査の本人のトークンを返す。手元の SSO の偽物が発行したコードを学び側の signInWithCode で換える。 */
async function ensureAccount(base, acc, sso) {
  const d = await apiCall(base, '/auth/sso', { method: 'POST', body: { code: sso.issue(acc.email, acc.name) } })
  return { ...acc, token: fieldOf(d, 'token', 'value', 'POST', '/auth/sso') }
}

/** 学び側の配備のまなびばの場所が手元の SSO の偽物か確かめ、偽物が発行するコードの宛て先（受け持つ学び）を返す。 */
async function ssoTarget(base) {
  const config = await apiCall(base, '/auth/config')
  if (!fieldOf(config, 'sso', 'present', 'GET', '/auth/config') || config.portal !== SSO_FAKE_URL) {
    throw new Error(
      `GET /api/auth/config: まなびばの場所が手元の SSO の偽物（${SSO_FAKE_URL}）でない（${JSON.stringify(config).slice(0, 100)}）。` +
        ' wrangler dev に SSO_PORTAL_URL と SSO_SECRET を渡して起動し直すこと（audit_screens.sh が渡す）',
    )
  }
  return String(config.app)
}

/** セッションを1本、最後まで解く。答えは巡回で選ぶので正誤が混ざる。 */
async function completeSession(base, token, createBody, maxAnswers = 200) {
  let created
  try {
    created = fieldOf(await apiCall(base, '/sessions', { method: 'POST', body: createBody, token }), 'id', 'value', 'POST', '/sessions')
  } catch (e) {
    if (e.status === 400) return null // 出題できる問題がない（弱点復習が空、など）
    throw e
  }
  const letters = ['ア', 'イ', 'ウ', 'エ']
  for (let n = 0; n < maxAnswers; n++) {
    const path = `/sessions/${created}/current`
    const cur = await apiCall(base, path, { token })
    if (fieldOf(cur, 'finished', 'present', 'GET', path) || !cur.question) break
    await apiCall(base, `/sessions/${created}/answer`, {
      method: 'POST',
      body: { idx: cur.question.idx, answer: letters[(cur.question.idx + n) % 4] },
      token,
    })
  }
  await apiCall(base, `/sessions/${created}/finish`, { method: 'POST', token })
  return created
}

/** セッションを途中まで解いて **中断したまま** にする（進行中の状態を作る）。 */
async function leaveInProgress(base, token, createBody, answers) {
  const held = fieldOf(await apiCall(base, '/sessions/current', { token }), 'session', 'present', 'GET', '/sessions/current')
  if (held) return held.id // すでに中断中のものがある
  const created = fieldOf(await apiCall(base, '/sessions', { method: 'POST', body: createBody, token }), 'id', 'value', 'POST', '/sessions')
  const letters = ['ア', 'イ', 'ウ', 'エ']
  for (let n = 0; n < answers; n++) {
    const path = `/sessions/${created}/current`
    const c = await apiCall(base, path, { token })
    if (fieldOf(c, 'finished', 'present', 'GET', path) || !c.question) break
    await apiCall(base, `/sessions/${created}/answer`, {
      method: 'POST',
      body: { idx: c.question.idx, answer: letters[n % 4] },
      token,
    })
  }
  return created
}

async function setProgress(base, token, topicIds, statusOf) {
  for (const [i, id] of topicIds.entries()) {
    await apiCall(base, `/topics/${id}/progress`, {
      method: 'PUT',
      body: { status: statusOf(i) },
      token,
    })
  }
}

async function completedSessions(base, token) {
  return fieldOf(await apiCall(base, '/sessions', { token }), 'sessions', 'list', 'GET', '/sessions')
}

export async function buildFixtures(base, { log = console.log } = {}) {
  const out = {}
  const sso = await startSsoFake(await ssoTarget(base))
  try {
    for (const acc of ACCOUNTS) {
      out[acc.key] = await ensureAccount(base, acc, sso)
      log(`  ${acc.key}: 手元の SSO の偽物のコードで入った`)
    }
  } finally {
    await sso.close()
  }

  // 論点 ID は実データから採る（並び順ではなく API が返す ID をそのまま使う）
  const listOf = async (path, key) => fieldOf(await apiCall(base, path, { token: out.audit_mid.token }), key, 'list', 'GET', path)
  const ids = (await listOf('/topics?limit=200', 'topics')).map((t) => t.id)
  const fields = await listOf('/fields', 'fields')
  const exams = await listOf('/exams', 'exams')

  // ---- audit_new は登録だけ。何もしない（進捗ゼロ・履歴ゼロが見本）
  const newHist = await completedSessions(base, out.audit_new.token)
  if (newHist.length > 0) log(`  ! audit_new に履歴が ${newHist.length} 件ある（前回の検査の残り）`)

  // ---- audit_mid: 進捗12件 → 練習テストを1回完走 → 過去問実践を中断したまま
  {
    const t = out.audit_mid.token
    await setProgress(base, t, ids.slice(0, 12), (i) => [1, 2, 3][i % 3])
    const done = await completedSessions(base, t)
    if (done.length === 0) {
      const f = fields[0]?.field
      const id = await completeSession(base, t, { kind: 'field', field: f, size: 10 })
      log(`  audit_mid: 練習テスト完走 ${id ?? '(作れず)'}`)
    } else {
      log(`  audit_mid: 完走済み ${done.length} 件（流用）`)
    }
    // 中断は最後に作る。進行中が1本あると新規セッションが作れないため。
    const exam = exams[0]?.exam
    const inprog = await leaveInProgress(base, t, { kind: 'mock', exam }, 3)
    log(`  audit_mid: 過去問実践を中断したまま ${inprog}`)
    out.audit_mid.inProgressSessionId = inprog
    out.audit_mid.completedSessionIds = (await completedSessions(base, t)).map((s) => s.id)
  }

  // ---- audit_heavy: 進捗多数 ＋ 完走10回以上（模試含む）
  {
    const t = out.audit_heavy.token
    await setProgress(base, t, ids.slice(0, 60), (i) => [3, 3, 2, 1][i % 4])
    let done = await completedSessions(base, t)
    const want = 11
    const plans = []
    for (let i = done.length; i < want; i++) {
      if (i % 4 === 3) plans.push({ kind: 'mock', size: 12 })
      else if (i % 4 === 2) plans.push({ kind: 'review', size: 10 })
      else plans.push({ kind: 'field', field: fields[i % fields.length]?.field, size: 10 })
    }
    for (const p of plans) {
      const id = await completeSession(base, t, p)
      if (!id) log(`  audit_heavy: ${p.kind} は出題できず飛ばした`)
    }
    done = await completedSessions(base, t)
    log(`  audit_heavy: 完走 ${done.length} 件 / 進捗 60 件`)
    out.audit_heavy.completedSessionIds = done.map((s) => s.id)
  }

  out.audit_new.completedSessionIds = []
  return out
}

/** 直接実行の本体。用意したアカウントの一覧を --json に書き出す。 */
async function main() {
  const base = arg('--base', 'http://127.0.0.1:8787')
  console.log(`▶ 検査用アカウントを用意する（${base}）`)
  let res
  try {
    res = await buildFixtures(base)
  } catch (e) {
    if (!(e instanceof UnreadableAnswer)) throw e
    // 標準出力がパイプのときの書き出しは非同期なので、process.exit で打ち切らずに終了の状態だけを決める
    process.stdout.write(`${toolErrorLine(e)}\n`)
    process.exitCode = 1
    return
  }
  const jsonPath = arg('--json', null)
  const dump = Object.fromEntries(
    Object.entries(res).map(([k, v]) => [
      k,
      { email: v.email, inProgressSessionId: v.inProgressSessionId ?? null, completedSessionIds: v.completedSessionIds ?? [] },
    ]),
  )
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(dump, null, 2))
  console.log('完了')
}

// 直接実行されたときだけ動く（audit_screens.mjs からは import して使う）
if (import.meta.url === `file://${process.argv[1]}`) await main()
