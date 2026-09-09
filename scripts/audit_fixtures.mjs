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
 * 作るアカウント（パスワードは共通 audit-pass-1234）:
 *   audit_new@example.com    登録だけ。進捗ゼロ・履歴ゼロ（＝空状態の見本）
 *   audit_mid@example.com    学習途中。進捗あり／完走1回／**過去問実践を中断したまま**
 *   audit_heavy@example.com  履歴が多い。完走10回以上（模試含む）／進捗多数
 *
 * 冪等。すでに居るアカウントは作り直さず、足りない分だけ足す。
 * **既存データは消さない**（DELETE を一切流さない。ローカル D1 には実データが入っている）。
 */
import { writeFileSync } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PASSWORD = 'audit-pass-1234'
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

/** ローカルで SIGNUP_CODE が設定されていれば .dev.vars から拾う（未設定なら合言葉は不要）。 */
function signupCodeFromDevVars() {
  const p = resolve(ROOT, '.dev.vars')
  if (!existsSync(p)) return undefined
  const m = readFileSync(p, 'utf8').match(/^\s*SIGNUP_CODE\s*=\s*"?([^"\n]*)"?\s*$/m)
  return m ? m[1] : undefined
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

/** 登録済みならログイン、いなければ登録する。 */
async function ensureAccount(base, acc, signupCode) {
  try {
    const d = await apiCall(base, '/auth/login', {
      method: 'POST',
      body: { email: acc.email, password: PASSWORD },
    })
    return { ...acc, token: d.token, created: false }
  } catch (e) {
    if (e.status !== 401) throw e
  }
  const d = await apiCall(base, '/auth/register', {
    method: 'POST',
    body: { email: acc.email, password: PASSWORD, name: acc.name, signupCode },
  })
  return { ...acc, token: d.token, created: true }
}

/** セッションを1本、最後まで解く。答えは巡回で選ぶので正誤が混ざる。 */
async function completeSession(base, token, createBody, maxAnswers = 200) {
  let created
  try {
    created = await apiCall(base, '/sessions', { method: 'POST', body: createBody, token })
  } catch (e) {
    if (e.status === 400) return null // 出題できる問題がない（弱点復習が空、など）
    throw e
  }
  const letters = ['ア', 'イ', 'ウ', 'エ']
  for (let n = 0; n < maxAnswers; n++) {
    const cur = await apiCall(base, `/sessions/${created.id}/current`, { token })
    if (cur.finished || !cur.question) break
    await apiCall(base, `/sessions/${created.id}/answer`, {
      method: 'POST',
      body: { idx: cur.question.idx, answer: letters[(cur.question.idx + n) % 4] },
      token,
    })
  }
  await apiCall(base, `/sessions/${created.id}/finish`, { method: 'POST', token })
  return created.id
}

/** セッションを途中まで解いて **中断したまま** にする（進行中の状態を作る）。 */
async function leaveInProgress(base, token, createBody, answers) {
  const cur = await apiCall(base, '/sessions/current', { token })
  if (cur.session) return cur.session.id // すでに中断中のものがある
  const created = await apiCall(base, '/sessions', { method: 'POST', body: createBody, token })
  const letters = ['ア', 'イ', 'ウ', 'エ']
  for (let n = 0; n < answers; n++) {
    const c = await apiCall(base, `/sessions/${created.id}/current`, { token })
    if (c.finished || !c.question) break
    await apiCall(base, `/sessions/${created.id}/answer`, {
      method: 'POST',
      body: { idx: c.question.idx, answer: letters[n % 4] },
      token,
    })
  }
  return created.id
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
  const d = await apiCall(base, '/sessions', { token })
  return d.sessions ?? []
}

export async function buildFixtures(base, { log = console.log } = {}) {
  const signupCode = arg('--signup-code', signupCodeFromDevVars())
  const out = {}

  for (const acc of ACCOUNTS) {
    const a = await ensureAccount(base, acc, signupCode)
    out[acc.key] = a
    log(`  ${acc.key}: ${a.created ? '新規登録' : '既存を流用'}`)
  }

  // 論点 ID は実データから採る（並び順ではなく API が返す ID をそのまま使う）
  const topicList = await apiCall(base, '/topics?limit=200', { token: out.audit_mid.token })
  const ids = topicList.topics.map((t) => t.id)
  const fields = (await apiCall(base, '/fields', { token: out.audit_mid.token })).fields
  const exams = (await apiCall(base, '/exams', { token: out.audit_mid.token })).exams

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

// 直接実行されたときだけ動く（audit_screens.mjs からは import して使う）
if (import.meta.url === `file://${process.argv[1]}`) {
  const base = arg('--base', 'http://127.0.0.1:8787')
  console.log(`▶ 検査用アカウントを用意する（${base}）`)
  const res = await buildFixtures(base)
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
