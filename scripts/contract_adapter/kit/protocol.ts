/**
 * 契約の実例の受け渡し（contract-run と受け持ちの間）の形。
 *
 * 受け持ちの書き方（次に受け持ちを足す担当へ）:
 *
 * 1. `scripts/contract_adapter/handlers/UC-nnn.ts` を 1 つ置く（UC 1 つに 1 ファイル。名前の UC と中の `uc` を一致させる）。
 *    土台（main.ts）は標準入力に来た UC のファイルだけを読み込むので、共有のファイルを編集しなくても拾われる。
 *    1 つの UC の操作を別の担当が受け持つとき（`http` と端末の記憶など）は、`handlers/UC-nnn.<名前>.ts` に分けて置いてよい
 *    （土台が操作を 1 つにまとめる。同じ操作を 2 つのファイルが持つと止まる）。
 * 2. ファイルは `export default defineHandler({ uc, parallel?, operations })` を 1 つだけ持つ。
 *    `operations` は契約の操作名 → 関数。関数は実例の行（ExampleLine）を受け、`{ response }` か `{ error: 名前 }` を返す。
 *    skip は返せない（UC-033 の契約）。実装が名前を出さずに止まった・断ったとき（道具が断りの名前を出さずに 0 でない終了の
 *    状態で止まった・HTTP の応答が名前を持たない）は、実装が返した物を、終了の状態や状態の番号を最上位に持たない入れ物に
 *    入れて応答として返す。道具は `{ unnamedStop: { exitCode, stderr } }`（kit/tool.ts の unnamedStop）、`http` は
 *    `{ unnamedRefusal: { status } }`、成功の状態で本文が JSON でなければ `{ unreadableBody: { status, body } }`（kit/http.ts の answerOf）。
 *    この入れ物はどの成功例の応答にも含まれないので、確かめはその実例を合わない物として挙げ、ほかの実例は回り続ける。
 *    契約が応答として認める 0 でない終了の状態は、道具がその結果を標準出力に出したときだけ応答と読む（kit/td.ts の answerOf）。
 *    投げる（答えを書かずに止める）のは、実装が何も返さないとき（名前の無い例外・時間切れ）と、前提を作れないときに限る
 *    （土台がその実例を挙げて失敗で終える）。子のプロセスは kit/tool.ts の runTool で起こす（受け渡し役より長く残さない）。
 * 3. 前提の状態は実例ごとに作る（REQ-570）。メモリの SQLite・影の根（kit/tool.ts の shadowRoot）を毎回新しく作り、
 *    ほかの実例と共有しない。同じ request で成功例と失敗例が並ぶ操作は、`line.case`（例の名前）と契約の errors の `when` で前提を分ける。
 * 4. 期待する応答はアダプターに届かない。応答は実装が返した物をそのまま返す（作らない・寄せない）。
 * 5. 子プロセスで道具を回す受け持ちは `parallel: true` にする（土台が並行に回す）。同じプロセスの中で実装を呼ぶ受け持ちは
 *    既定（順に 1 件ずつ）のままにする。時計・ID・外への口（kit/outside.ts）はプロセスに 1 つなので、並行に回すと混ざる。
 * 6. 外へ出る口は土台が塞いである（kit/outside.ts）。外の相手が要る実例は withFetch で偽の相手を立てる。道具は影の根と
 *    偽のコマンド（kit/tool.ts の fakeCommands）に向けて回し、本番の保存先・配備先に届く形で回さない（REQ-569）。
 * 7. export する関数とクラスには `@implements`（REQ か BR）を直上に付ける（scripts/contract_adapter/** は実現単位の置き場）。
 */

/** contract-run が標準入力に書く 1 行（UC-033 の契約 ExampleLine）。 */
export type ExampleLine = {
  id: number
  uc: string
  operation: string
  transport: string
  direction: 'inbound' | 'outbound'
  owned: boolean
  auth: string
  wire: { method: string; path: string; success: number } | null
  entry: string | null
  request: Record<string, unknown> | null
  case: string
}

/** 実例 1 件への答え（UC-033 の契約 Reply から id を除いた物）。 */
export type Answer = { response: Record<string, unknown> } | { error: string }

/** 操作 1 つの受け持ち。 */
export type Operation = (line: ExampleLine) => Promise<Answer>

/** UC 1 つの受け持ち。 */
export type Handler = {
  uc: string
  /** 子プロセスを回す受け持ちだけ true（並行に回す）。既定は 1 件ずつ順に回す。 */
  parallel?: boolean
  operations: Record<string, Operation>
  /** 土台が使う（並行に回す操作の名前）。受け持ちは書かない。 */
  parallelOperations?: Set<string>
}

/**
 * 実装に渡せなかった実例（当たる入口が無い・実装が何も返さない（名前の無い例外・時間切れ）・前提を作れない）。土台がその実例を挙げて失敗で終える。
 * @implements REQ-568
 */
export class Unanswerable extends Error {}

/**
 * 受け持ちを宣言する（形を型で確かめるだけで、値はそのまま返す）。
 * @implements REQ-567
 */
export function defineHandler(handler: Handler): Handler {
  return handler
}
