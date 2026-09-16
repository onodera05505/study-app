const TOKEN_KEY = 'study-app.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}
/** ログインしている人の名前。トークン（JWT）の中身から読む。サーバに聞かない。
 *  「ログインしている私が誰か分からない」（利用者のフィードバック 2026-09-16）に応えてヘッダーに出す。 */
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

export async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getToken()
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
    throw new ApiError(
      '通信できませんでした。電波の状態を確認して、もう一度お試しください。',
      undefined,
      null,
    )
  }
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    if (res.status === 401) {
      // トークンを持って行って弾かれた＝期限切れ。持っていなければ元から
      // 未ログインなので、期限切れとは言わない。
      if (token) markSessionExpired()
      clearToken()
    }
    throw new ApiError(data?.error ?? '通信に失敗しました', res.status, data)
  }
  return data as T
}

/** 画面を移るたびに取り直さなくてよいものを、ページを開いている間だけ覚えておく。
 *
 *  シラバスの分野・単元は、回を追加しても構造が変わらない。にもかかわらず
 *  `/topics` へ入るたびに `/fields` と `/categories` を取り直していて、
 *  そのぶん画面が出るのが遅れていた（1リクエストあたり 0.2〜0.4 秒かかる）。
 *
 *  **リロードすれば消える**ので、データを入れ替えたあとは再読み込みで最新になる。
 *  内容が変わりうるもの（論点一覧・進捗・受験履歴）には使わないこと。 */
const memo = new Map<string, Promise<unknown>>()

/** 覚えたものを捨てる。進捗を変えた直後に呼ぶ。
 *  /fields と /categories は分野・単元の構造だけでなく「理解した数」も返す（進捗の集計を含む）。
 *  理解度を付けて一覧へ戻っても古い数が出続け、再読み込みで直る、という不具合の原因だった
 *  （利用者のフィードバック 2026-09-16）。 */
export function invalidateCached() {
  memo.clear()
}

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

export function getLastTopic(): LastTopic | null {
  try {
    const raw = localStorage.getItem(LAST_TOPIC_KEY)
    return raw ? (JSON.parse(raw) as LastTopic) : null
  } catch {
    return null
  }
}

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
  term: string
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
