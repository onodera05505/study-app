import { defineConfig } from 'vitest/config'

/** 単体テスト。既定は node（サーバ・共有のロジック）。
 *  画面を描くテストはファイルの先頭に `// @vitest-environment jsdom` を書いて切り替える。 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
  },
})
