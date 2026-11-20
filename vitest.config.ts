import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'

/** 単体テスト。既定は node（サーバ・共有のロジック）。
 *  画面を描くテストはファイルの先頭に `// @vitest-environment jsdom` を書いて切り替える。
 *
 *  テストは 2 つの組に分けて、組の順に回す（sequence.groupOrder）。
 *  - main: ほとんどのテスト。ファイルどうしを並べて回す
 *  - alone: 作業ツリーそのものに契約の実例の確かめ（全部の実例）を当てるテスト。確かめは全体で 120 秒の上限を持ち、
 *    UC-036 の実例は手元の決まった口を使うので、ほかのテスト（とくに同じ口を鍵つきで数分持つ UC-036 のテスト）と並べると、
 *    CPU と口の順番待ちで上限を超える。main がすべて終わってから、単独で回す
 *  どちらの組もこの設定の test を引き継ぐ（extends）。片付け（afterAll など）の上限は、負荷の高い回でも足りるように 1 か所で持つ。 */
const ALONE = ['tests/scenario/UC-033-run-contract-examples-against-implementation.test.tsx']

/** ファイルを並べて回す数の上限（使えるコアの半分、下限 2）。テストの多くが子プロセス（Python・wrangler dev・vite・tsx）を起こすので、
 *  コアの数だけ並べると子の分まで CPU を取り合い、時間の上限を持つテストが回ごとに別の所で落ちる。
 *  この値はルートの test に置くので、2 つの組と、この設定を土台にする記録つきの設定のどれにも効く。 */
const MAX_WORKERS = Math.max(2, Math.floor(availableParallelism() / 2))

export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 120_000,
    maxWorkers: MAX_WORKERS,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
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
