import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ExampleKey, ROOT, contractRun, keyOf, opWith, realExample, removeTemps, runsTestMs, shadowRoot, tailOf, verdictOf } from './UC-033_fixture.local'

/**
 * UC-033 の REQ-567・568: 外の相手を呼ぶ操作（本番の確かめ。UC-015 の openDeploymentEntry）の実例が、
 * 道具が実際にその経路を開いたときだけ通ること。
 *
 * 経路を開かない道具は、影の根（`--root`）で本番の確かめの道具 `scripts/check_sso_prod.sh` 1 本だけを差し替えて作る。
 * 差し替えた道具は本物の道具をそのまま回すが、決めた 1 つの URL の要求だけは代わりの配備先へ送らず、
 * 手元で 200 の応答をこしらえて受け取ったことにする（代わりの配備先の到着の記録 `TC_FAKE_LOG` に残らない別の口から答える）。
 * ほかの経路は本物の道具のまま開く。実装（本物の道具の中身）は読まず、外から包むだけにする。
 */

const ENTRY = ['UC-015', 'openDeploymentEntry'] as const
const entry = (name: string): ExampleKey => ({ uc: ENTRY[0], operation: ENTRY[1], case: name })

/** 配備の URL（値の正本は scripts/pages_projects.json と登録簿 scripts/targets.py）。末尾の / は除く。 */
const deploymentUrl = (key: string): string => {
  const url =
    key === '_portal'
      ? String((JSON.parse(readFileSync(join(ROOT, 'scripts', 'pages_projects.json'), 'utf8')) as { _portal: { url: string } })._portal.url)
      : execFileSync('python3', [join(ROOT, 'scripts', 'targets.py'), 'url', key], { cwd: ROOT, encoding: 'utf8' }).trim()
  return url.replace(/\/+$/, '')
}

/** 本物の本番の確かめを回し、drop の URL（クエリと末尾の / を除いて比べる）の要求だけを配備へ送らない道具。drop が空なら何も落とさない。 */
const toolSkipping = (drop: string): string => `#!/bin/bash
# 影の根の道具（UC-033 のテスト）: 本物の確かめを回すが、決めた URL の要求だけは配備へ送らず、手元で応答をこしらえる
shim="$(mktemp -d)"
next="$(command -v curl)"
cat > "$shim/curl" <<SHIM
#!/bin/bash
for a in "\\$@"; do
  case "\\$a" in http://*|https://*)
    u="\\\${a%%\\\\?*}"; while [ "\\\${u%/}" != "\\$u" ]; do u="\\\${u%/}"; done
    if [ -n "${drop}" ] && [ "\\$u" = "${drop}" ]; then TC_FAKE_LOG=/dev/null TC_FAKE_RULES=/dev/null exec "$next" "\\$@"; fi ;;
  esac
done
exec "$next" "\\$@"
SHIM
chmod +x "$shim/curl"
PATH="$shim:$PATH" bash "${join(ROOT, 'scripts', 'check_sso_prod.sh')}" "$@"
code=$?
rm -rf "$shim"
exit $code
`

/** openDeploymentEntry の決めた実例だけを持つ契約と、drop の URL を開かない道具を置いた影の根で確かめを回す。 */
const runEntry = (names: string[], drop: string) => {
  const root = shadowRoot({
    contracts: [{ uc: ENTRY[0], operations: { [ENTRY[1]]: opWith(...ENTRY, Object.fromEntries(names.map((n) => [n, realExample(...ENTRY, n)]))) } }],
    tools: { 'check_sso_prod.sh': toolSkipping(drop) },
  })
  return contractRun(['--root', root, '--json'])
}

afterAll(async () => {
  await removeTemps()
})

describe('UC-033 確定した契約の実例を実装に当て、契約どおりに応えない版を見つける', () => {
  describe('REQ-567 成功例では実装の応答が例の応答を含むときだけ通る（外の相手を呼ぶ操作）', () => {
    // @covers REQ-567#success-shape
    it('本番の確かめの道具が入口の画面を成す経路をすべて開けば、開けた経路の成功例は通る（包んだだけの道具で）', async () => {
      const names = ['ok', 'okPortalScript', 'okPortalStyle', 'okLearning']
      const run = await runEntry(names, '')
      expect(run.results, `--json の結果が読めない（終了 ${run.code}）:\n${tailOf(run)}`).not.toBeNull()
      for (const name of names) expect(verdictOf(run, entry(name))?.verdict, `${keyOf(entry(name))}:\n${tailOf(run)}`).toBe('pass')
      expect(run.code, tailOf(run)).toBe(0)
    }, runsTestMs())
  })

  describe('REQ-568 合わない・不備・渡せない実例があれば、その実例を挙げて失敗で終える', () => {
    for (const { name, deployment, path, what } of [
      { name: 'okPortalStyle', deployment: '_portal', path: '/style.css', what: 'まなびばの入口の /style.css' },
      { name: 'okLearning', deployment: 'ip', path: '', what: '学び側の入口の /' },
    ]) {
      // @covers REQ-568#unreachable
      it(`本番の確かめの道具が ${what} を開かなければ、その経路の成功例は通らず、失敗で終える`, async () => {
        const run = await runEntry([name], `${deploymentUrl(deployment)}${path}`)
        expect(verdictOf(run, entry(name))?.verdict, `経路を開かない道具で ${keyOf(entry(name))} が通った:\n${tailOf(run)}`).not.toBe('pass')
        expect(run.code, `経路を開かない道具で通った:\n${tailOf(run)}`).not.toBe(0)
        expect(run.code, '止められて終わった').not.toBe(-1)
        // 挙げたことは、結果（--json の results）にその実例が失敗の判定で載ることで見る（出力の文言の形には寄らない）
        expect(verdictOf(run, entry(name))?.verdict, `通らなかった ${keyOf(entry(name))} が失敗として挙がっていない:\n${tailOf(run)}`).toBe('fail')
      }, runsTestMs())
    }
  })
})
