/**
 * 実行の記録の足場（ADR-0015）: 記録つきで回す vitest の設定。run.mjs だけが使う（既定の vitest.config.ts の動きは変えない）。
 * 置き場（TEST_RECORD_ROOT）の vitest.config.ts があればそれを土台にし、同じプロセスの記録（V8）と、子プロセスに記録の環境を足す
 * setupFiles を重ねる。範囲のファイルは 1 行も実行されなくても記録に載せ、テストが落ちた回も記録を書き出す。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = process.env.TEST_RECORD_ROOT
const raw = process.env.TEST_RECORD_RAW
if (!root || !raw) throw new Error('記録つきの設定は tests/support/coverage/run.mjs から使う（TEST_RECORD_ROOT と TEST_RECORD_RAW が無い）')

const basePath = join(root, 'vitest.config.ts')
const base = existsSync(basePath) ? (await import(pathToFileURL(basePath).href)).default : {}
const test = base.test ?? {}
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])

export default {
  ...base,
  root,
  test: {
    ...test,
    setupFiles: [...list(test.setupFiles), join(here, 'child-env.mjs')],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: [
        'src/**/*.{ts,tsx,js,mjs}',
        'portal/src/**/*.{ts,tsx,js,mjs}',
        'portal/static/**/*.{ts,tsx,js,mjs}',
        'scripts/**/*.{ts,tsx,js,mjs}',
      ],
      exclude: ['**/*.d.ts', '**/node_modules/**'],
      reporter: [['lcovonly', { file: 'lcov.info' }]],
      reportsDirectory: join(raw, 'ts'),
      reportOnFailure: true,
      clean: true,
    },
  },
}
