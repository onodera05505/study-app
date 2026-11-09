const TOKEN_KEY = 'study-app.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
// @implements REQ-191
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}
/** ログインしている人の名前。トークン（JWT）の中身から読む。サーバに聞かない。
 *  誰でログインしているかが分かるよう、ヘッダーに出す。 */
// @implements REQ-199
export function getUserName(): string | null {
  const token = getToken()
  if (!token) return null
  try {
    const payload = token.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const name = (JSON.parse(decodeURIComponent(escape(json))) as { name?: string }).name
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}

// @implements REQ-198, BR-010
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  // 「前回の続き」は端末に残る。消さないと、次にログインした別のアカウントに
  // 前の人が読んでいた論点が出る（同じ端末を分け合って使うことがある）。
  localStorage.removeItem(LAST_TOPIC_KEY)
}

/** トークンが期限切れで捨てられたことの印。
 *
 *  401 で締め出されると、操作の途中でも黙ってログイン画面に戻る。何が起きたのか
 *  分からないと「パスワードを間違えた」と受け取られるので、理由を1度だけ伝える。
 *  自分でログアウトしたときには立てない（そのときは分かっている）。
 *  タブを閉じれば消えてよい情報なので sessionStorage に置く。 */
const EXPIRED_KEY = 'study-app.sessionExpired'

function markSessionExpired() {
  try {
    sessionStorage.setItem(EXPIRED_KEY, '1')
  } catch {
    // プライベートモードなどで保存できなくても、ログイン自体は妨げない
  }
}

/** 印が立っていれば true を返し、同時に消す（出すのは一度だけ）。 */
// @implements REQ-197, BR-011
export function takeSessionExpired(): boolean {
  try {
    const hit = sessionStorage.getItem(EXPIRED_KEY) === '1'
    if (hit) sessionStorage.removeItem(EXPIRED_KEY)
    return hit
  } catch {
    return false
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP のステータス。通信そのものが成立しなかったときは undefined。 */
    readonly status: number | undefined,
    readonly body: any,
  ) {
    super(message)
  }
}

/** 応答の本文を JSON として読む。空なら null。
 *
 *  失敗の応答（ok でない）の本文は、中継機の HTML やプレーンテキストのことがあり、
 *  JSON として読めなくても「理由が無い失敗」として扱う（null を返す）。
 *  成功の応答で本文が読めないのは契約違反なので、そのまま投げる。 */
// @implements REQ-261
function parseBody(text: string, ok: boolean): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (e) {
    if (ok) throw e
    return null
  }
}

// @implements REQ-196
export async function api<T = any>(
  path: string,
  /** anonymous: 端末のトークンを添えず、401 でもトークンを捨てない（本人を得る前の要求に使う）。 */
  init: { method?: string; body?: unknown; anonymous?: boolean } = {},
): Promise<T> {
  const token = init.anonymous ? null : getToken()
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
  } catch {
    // 電波が無い・オフラインだと fetch は TypeError を投げる。そのままだと
    // ブラウザの英語メッセージ（Failed to fetch）が画面に出る。
    // サーバまで届いていないので status は無い（undefined のまま）。
    // @implements REQ-262
    throw new ApiError(
      '通信できませんでした。電波の状態を確認して、もう一度お試しください。',
      undefined,
      null,
    )
  }
  const text = await res.text()
  const data = parseBody(text, res.ok)
  if (!res.ok) {
    if (res.status === 401 && !init.anonymous) {
      // トークンを持って行って弾かれた＝期限切れ。持っていなければ元から
      // 未ログインなので、期限切れとは言わない。
      // @implements REQ-194, REQ-197
      if (token) markSessionExpired()
      clearToken()
    }
    // @implements REQ-261
    throw new ApiError(data?.error ?? '通信に失敗しました', res.status, data)
  }
  return data as T
}

/** 画面を移るたびに取り直さなくてよいものを、ページを開いている間だけ覚えておく。
 *
 *  シラバスの分野・単元は、回を追加しても構造が変わらない。`/topics` へ入るたびに
 *  `/fields` と `/categories` を取り直すと、そのぶん画面が出るのが遅れる（1リクエストあたり 0.2〜0.4 秒）。
 *
 *  **リロードすれば消える**ので、データを入れ替えたあとは再読み込みで最新になる。
 *  内容が変わりうるもの（論点一覧・進捗・受験履歴）には使わないこと。 */
const memo = new Map<string, Promise<unknown>>()

/** 覚えたものを捨てる。進捗を変えた直後に呼ぶ。
 *  /fields と /categories は分野・単元の構造だけでなく「理解した数」も返す（進捗の集計を含む）ので、
 *  捨てずにいると理解度を付けて一覧へ戻ったときに古い数が出る。 */
export function invalidateCached() {
  memo.clear()
}

// @implements REQ-017, REQ-018
export function apiCached<T = any>(path: string): Promise<T> {
  const hit = memo.get(path)
  if (hit) return hit as Promise<T>
  // 失敗したら覚えたままにしない。次に開いたときに取り直せるようにする
  const p = api<T>(path).catch((e) => {
    memo.delete(path)
    throw e
  })
  memo.set(path, p)
  return p
}

/** 最後に開いた論点。「前回の続き」を出すためだけに使う。
 *
 *  サーバに持たせるほどの情報ではないし、端末ごとに違ってよい。
 *  （別の端末で読んだ続きを出されても、それは「前回の続き」ではない） */
const LAST_TOPIC_KEY = 'study-app.lastTopic'

export type LastTopic = { id: number; term: string; middle: string; middleNo: number }

/** 端末から読んだ値が LastTopic の形か。形でない値は覚えていないのと同じに扱う。 */
function isLastTopic(v: unknown): v is LastTopic {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return (
    Number.isInteger(t.id) && (t.id as number) >= 1 &&
    typeof t.term === 'string' && t.term !== '' &&
    typeof t.middle === 'string' && t.middle !== '' &&
    Number.isInteger(t.middleNo) && (t.middleNo as number) >= 1
  )
}

// @implements REQ-082, BR-011, BR-012, BR-041
export function getLastTopic(): LastTopic | null {
  try {
    const raw = localStorage.getItem(LAST_TOPIC_KEY)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return isLastTopic(v) ? v : null
  } catch {
    return null
  }
}

/** この端末が覚えた前回の続きを捨てる。 */
// @implements REQ-342
export function clearLastTopic() {
  try {
    localStorage.removeItem(LAST_TOPIC_KEY)
  } catch {
    // 端末の記憶が使えなければ、読み出しも null になるので捨てられないままでよい
  }
}

// @implements REQ-077, REQ-078, BR-011, BR-013
export function setLastTopic(t: LastTopic) {
  try {
    localStorage.setItem(LAST_TOPIC_KEY, JSON.stringify(t))
  } catch {
    // プライベートモードなどで保存できなくても、機能そのものは止めない
  }
}

export type Field = {
  field: string
  topics: number
  questions: number
  understood: number
  partly: number
  untouched: number
}

export type TopicRow = {
  id: number
  /** 論点の名前。副題を含まない */
  term: string
  /** 名前に添える副題。副題を持たない論点では null */
  subtitle: string | null
  questionCount: number
  status: number | null
  field: string
  middle: string
  itemName: string
  isNew: number
}

export const STATUS_LABEL: Record<number, string> = {
  1: '未理解',
  2: 'やや理解',
  3: '理解',
}

export const STATUS_CLASS: Record<number, string> = {
  1: 'status-1',
  2: 'status-2',
  3: 'status-3',
}
