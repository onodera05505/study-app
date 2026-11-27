import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { parseEnv } from 'node:util'
import { configDefaults, defineConfig } from 'vitest/config'

/** 単体テスト。既定は node（サーバ・共有のロジック）。
 *  画面を描くテストはファイルの先頭に `// @vitest-environment jsdom` を書いて切り替える。
 *
 *  テストは 3 つの組に分け、組の順に回す（sequence.groupOrder）。分け方はファイルの名前だけで決める。
 *  - portable: 手元に依らないテストのファイル（名前が `.local.test.ts`・`.local.test.tsx` で終わらない物）。ファイルどうしを並べて回す。
 *    共有の置き場の検査（scripts/run_portable_checks.sh）はこの組だけを回す
 *  - local: 手元だけのテストのファイル（名前が `.local.test.ts`・`.local.test.tsx` で終わる物。手元の物の土台を読み込む）。
 *    portable と並べて回す。名前と中身が合っていることは scripts/classify_checks.ts が見る
 *  - alone: 作業ツリーそのものに契約の実例の確かめ（全部の実例）を当てる手元だけのテスト。手元だけの名前のファイルだけを抱え、
 *    手元に依らない名前のファイルは名前の形によらず portable が回す。確かめは全体で 120 秒の上限を持ち、
 *    UC-036 の実例は手元の決まった口を使うので、ほかのテスト（とくに同じ口を鍵つきで数分持つ UC-036 のテスト）と並べると、
 *    CPU と口の順番待ちで上限を超える。portable と local がすべて終わってから、単独で回す
 *  `vitest run`（組を絞らない）は 3 つの組を全部回す。どの組もこの設定の test を引き継ぐ（extends）。
 *  片付け（afterAll など）の上限は、負荷の高い回でも足りるように 1 か所で持つ。 */
const ALONE = ['tests/scenario/UC-033-run-contract-examples-against-implementation.local.test.tsx']
const LOCAL = ['tests/**/*.local.test.ts', 'tests/**/*.local.test.tsx']

/** ファイルを並べて回す数の上限（使えるコアの半分、下限 2）。テストの多くが子プロセス（Python・wrangler dev・vite・tsx）を起こすので、
 *  コアの数だけ並べると子の分まで CPU を取り合い、時間の上限を持つテストが回ごとに別の所で落ちる。
 *  この値はルートの test に置くので、3 つの組と、この設定を土台にする記録つきの設定のどれにも効く。 */
const MAX_WORKERS = Math.max(2, Math.floor(availableParallelism() / 2))

/** テストの中の画面がどの学びのものか（import.meta.env.VITE_EXAM など）。リポジトリが追跡する ip の配備の設定（`.env.ip`）から採り、
 *  追跡しない既定の `.env` は読まない（envDir: false）。どのクローンでも同じ学びで回るように。
 *  ほかの学びを描くテストは、ファイルの中で vi.stubEnv で差し替える。 */
const TEST_ENV = parseEnv(readFileSync(new URL('./.env.ip', import.meta.url), 'utf8'))

export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    env: TEST_ENV,
    hookTimeout: 120_000,
    maxWorkers: MAX_WORKERS,
    projects: [
      {
        extends: true,
        test: {
          name: 'portable',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, ...LOCAL, ...ALONE],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'local',
          include: LOCAL,
          exclude: [...configDefaults.exclude, ...ALONE],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'alone',
          include: ALONE,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
