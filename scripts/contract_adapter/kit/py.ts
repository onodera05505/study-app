/**
 * 道具の中の読み書きの操作（契約の `transport: local-store`・`direction: outbound` の `read…`・`write…`）を、
 * Python の関数として呼ぶ橋。入口の規則は CLAUDE.md の「操作 → 入口」の「道具の中の読み書き」の行と ADR-0013。
 *
 * 使い方（受け持ち `handlers/UC-nnn.io.ts` から）:
 * ```ts
 * import { callOperation, pyAnswer } from '../kit/py'
 * readUnitPlan: async (line) =>
 *   inShadow(async (shadow) => {
 *     await writePlan(shadow, 'ip', ...)                       // 前提のファイルを影の根に置く
 *     return pyAnswer(await callOperation(line.uc, line.operation, line.request, { cwd: shadow.root }))
 *   }),
 * ```
 * - callOperation(uc, operation, request, { cwd, env?, timeoutMs? }):
 *   `scripts/` の中で `@operation <uc>#<operation>` の注釈の行を持つファイルを引き（1 操作に 1 か所。0 か 2 か所以上なら
 *   Unanswerable を投げる）、そのファイルの最上位の関数（操作名を snake_case にした名前）を、request の項目をその名前のまま
 *   キーワード引数にして呼ぶ。Python は cwd を作業ディレクトリにして子プロセスで起こす（契約のパスは相対なら作業ディレクトリが起点）。
 *   環境変数は既定で親のものをそのまま引き継ぐ。子プロセスは kit/tool.ts の runTool で回すので、受け持ちは `parallel: true` にする。
 *   返すのは `{ value }`（関数の返り値）か `{ code }`（投げられた値の `code`。ADR-0012 の鍵）。
 *   名前を持たない失敗（`code` が文字列でない例外・SystemExit・関数が無い・返り値が JSON にできない）は Unanswerable を投げる。
 * - pyAnswer(result): `{ value }` がオブジェクトならそのまま `{ response }`、`{ code }` なら `{ error }`。値を作らない・寄せない。
 * - pythonEntry(uc, operation): 呼ぶファイルと関数の名前だけを引く（注釈の表はプロセスに 1 回だけ読む）。
 * - 関数が標準出力に書いた物は標準エラーへ回し、答えは別の行で受け取るので、関数の出力と混ざらない。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Unanswerable, type Answer } from './protocol'
import { REPO_ROOT, runTool } from './tool'

/** 関数を呼んだ結果。 */
export type PyResult = { value: unknown } | { code: string }

/** 呼ぶ先（リポジトリの根からの相対のファイルと関数の名前）。 */
export type PyEntry = { file: string; func: string }

const SCRIPTS = join(REPO_ROOT, 'scripts')
const ANNOTATION = /@operation\s+(UC-\d+#[A-Za-z][A-Za-z0-9]*)/g

let table: Map<string, string[]> | null = null

/** scripts/ の Python の `@operation` の注釈を読み、`UC-nnn#操作名` → ファイルの表を作る（scripts/contract_adapter は見ない）。 */
function annotations(): Map<string, string[]> {
  if (table) return table
  const found = new Map<string, string[]>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name !== 'contract_adapter' && name !== '__pycache__' && name !== 'node_modules') walk(path)
      } else if (name.endsWith('.py')) {
        for (const m of readFileSync(path, 'utf8').matchAll(ANNOTATION)) {
          const rel = relative(REPO_ROOT, path)
          const files = found.get(m[1]) ?? []
          if (!files.includes(rel)) files.push(rel)
          found.set(m[1], files)
        }
      }
    }
  }
  walk(SCRIPTS)
  table = found
  return found
}

/**
 * 操作名を snake_case にする（readUnitPlan → read_unit_plan）。
 * @implements REQ-579
 */
export function snakeCase(operation: string): string {
  return operation.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase()
}

/**
 * 操作の入口の関数を引く。注釈が 0 か 2 か所以上なら Unanswerable を投げる。
 * @implements REQ-567, REQ-579
 */
export function pythonEntry(uc: string, operation: string): PyEntry {
  const files = annotations().get(`${uc}#${operation}`) ?? []
  if (files.length !== 1) {
    throw new Unanswerable(`${uc}#${operation} の @operation を持つ Python のファイルが ${files.length} 個（1 個であること）: ${files.join(', ')}`)
  }
  return { file: files[0], func: snakeCase(operation) }
}

/** 子の Python。argv: ファイル・関数の名前・答えを書く印。標準入力: request の JSON。 */
const DRIVER = String.raw`
import importlib.util, json, os, sys, traceback
path, name, mark = sys.argv[1], sys.argv[2], sys.argv[3]
raw = sys.stdin.read()
request = json.loads(raw) if raw.strip() else None
real = sys.stdout
sys.stdout = sys.stderr
answer = lambda obj: (real.write("\n" + mark + json.dumps(obj, ensure_ascii=False) + "\n"), real.flush())
try:
    sys.path.insert(0, os.path.dirname(path))
    module_name = os.path.splitext(os.path.basename(path))[0]
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
except BaseException:
    answer({"bridge": "読み込めない: " + traceback.format_exc(limit=3)[-400:]})
    sys.exit(0)
fn = getattr(module, name, None)
if not callable(fn):
    answer({"bridge": "関数 " + name + " が無い"})
    sys.exit(0)
try:
    value = fn(**(request or {}))
except SystemExit as e:
    answer({"bridge": "SystemExit で止まった: " + repr(e.code)})
    sys.exit(0)
except Exception as e:
    code = getattr(e, "code", None)
    if isinstance(code, str) and code:
        answer({"code": code})
    else:
        answer({"bridge": "名前を持たない失敗: " + "".join(traceback.format_exception_only(type(e), e)).strip()[-400:]})
    sys.exit(0)
try:
    answer({"value": value})
except (TypeError, ValueError) as e:
    answer({"bridge": "返り値を JSON にできない: " + str(e)[-200:]})
`

let marks = 0

/**
 * 契約の操作の入口の関数を呼ぶ。返り値か、投げられた値の名前（code）を返す。
 * @implements REQ-567, REQ-570, REQ-579
 */
export async function callOperation(
  uc: string,
  operation: string,
  request: Record<string, unknown> | null,
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<PyResult> {
  const entry = pythonEntry(uc, operation)
  const mark = `@@py-bridge-${process.pid}-${++marks}@@`
  const run = await runTool(['python3', '-c', DRIVER, join(REPO_ROOT, entry.file), entry.func, mark], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: JSON.stringify(request ?? {}),
    timeoutMs: options.timeoutMs ?? 30_000,
  })
  const line = run.stdout.split('\n').find((l) => l.startsWith(mark))
  if (line === undefined) {
    const tail = run.stderr.trim().split('\n').slice(-3).join(' / ')
    throw new Unanswerable(`${uc}#${operation}（${entry.file} の ${entry.func}）が答えを返さない（終了の状態 ${run.code}）: ${tail.slice(0, 300)}`)
  }
  const out = JSON.parse(line.slice(mark.length)) as { value?: unknown; code?: string; bridge?: string }
  if (typeof out.code === 'string') return { code: out.code }
  if ('value' in out) return { value: out.value }
  throw new Unanswerable(`${uc}#${operation}（${entry.file} の ${entry.func}）: ${out.bridge ?? '答えの形が違う'}`)
}

/**
 * 呼んだ結果を答えに読む。返り値がオブジェクトでなければ Unanswerable を投げる（契約の response はオブジェクト）。
 * @implements REQ-567, REQ-579
 */
export function pyAnswer(result: PyResult): Answer {
  if ('code' in result) return { error: result.code }
  const value = result.value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { response: value as Record<string, unknown> }
  throw new Unanswerable(`関数の返り値が契約の response の形（オブジェクト）でない: ${JSON.stringify(value)?.slice(0, 200)}`)
}
