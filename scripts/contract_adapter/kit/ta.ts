/**
 * 道具を回す受け持ち（UC-019・UC-028 の inbound）が共有する部品。kit/tool.ts の上に、次の 3 つを足す。
 *
 * - 作業場所: 実例ごとの影の根の下の `w/` を、道具を呼ぶ作業ディレクトリにする。契約のパス（data・out・answers・explain）は
 *   相対なら作業ディレクトリが起点なので、`../learner_packs/…` のような出力先も影の根の中（`<影の根>/learner_packs/…`）に収まる。
 * - 写し: リポジトリの置き場（data/<学び>・public/figures/materials/<学び>・tests/fixtures/…）を作業場所へ写す。
 *   大きな置き場（資格対策の学びの data/ip）を実例ごとに写すので、写しはファイルの複製（clone）で作る。
 * - 呼び方: request の欄を、欄の名前のままの長い名前の引数（`--<欄> <値>`）に、request に現れた順で並べる。
 *   道具の応答は標準出力の JSON 1 つ（成功は終了の状態 0）、断りの名前は kit/tool.ts の toolAnswer で読む。
 */

import { constants } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Unanswerable, type Answer, type ExampleLine } from './protocol'
import { REPO_ROOT, runTool, shadowRoot, toolAnswer, type Shadow } from './tool'

/** 道具を呼ぶ作業場所（影の根の下）。 */
export type Place = {
  shadow: Shadow
  /** 作業場所の絶対パス。 */
  dir: string
  /** 作業場所からの相対パスを絶対パスにする。 */
  abs: (rel: string) => string
  exists: (rel: string) => Promise<boolean>
  write: (rel: string, content: string | Uint8Array) => Promise<void>
  writeJson: (rel: string, value: unknown) => Promise<void>
  readJson: <T = any>(rel: string) => Promise<T>
  remove: (rel: string) => Promise<void>
  /** リポジトリの根からの相対パス（ファイルかディレクトリ）を、作業場所の to（既定は同じ相対パス）へ複製で写す。 */
  copyFromRepo: (rel: string, to?: string, skip?: (relInside: string) => boolean) => Promise<void>
}

/**
 * 実例 1 件の作業場所を作る（影の根の下の w/）。
 * @implements REQ-570
 */
export async function makePlace(): Promise<Place> {
  const shadow = await shadowRoot()
  const dir = shadow.path('w')
  await mkdir(dir, { recursive: true })
  const abs = (rel: string) => join(dir, rel)
  const write = async (rel: string, content: string | Uint8Array) => {
    await mkdir(dirname(abs(rel)), { recursive: true })
    await writeFile(abs(rel), content)
  }
  return {
    shadow,
    dir,
    abs,
    exists: async (rel) => {
      try {
        await readFile(abs(rel))
        return true
      } catch {
        return false
      }
    },
    write,
    writeJson: (rel, value) => write(rel, `${JSON.stringify(value, null, 2)}\n`),
    readJson: async (rel) => JSON.parse(await readFile(abs(rel), 'utf8')),
    remove: (rel) => rm(abs(rel), { recursive: true, force: true }),
    copyFromRepo: async (rel, to = rel, skip) => {
      const from = join(REPO_ROOT, rel)
      await mkdir(dirname(abs(to)), { recursive: true })
      await cp(from, abs(to), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        filter: skip ? (source) => !skip(source.slice(from.length).replace(/^\//, '')) : undefined,
      })
    },
  }
}

/**
 * request の欄を、欄の名前のままの長い名前の引数に、request に現れた順で並べる（値は文字列にする）。
 * @implements REQ-567
 */
export function argsOf(request: Record<string, unknown> | null): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(request ?? {})) args.push(`--${key}`, String(value))
  return args
}

/**
 * 道具（`scripts/<名前>`）を作業場所で回し、答えに読む。成功の応答は標準出力の JSON 1 つをそのまま返す。
 * 子プロセスには親の環境変数をそのまま引き継ぐ。
 * @implements REQ-567, REQ-568, BR-064
 */
export async function runEntry(place: Place, script: string, line: ExampleLine): Promise<Answer> {
  const run = await runTool(['python3', join(REPO_ROOT, 'scripts', script), ...argsOf(line.request)], {
    cwd: place.dir,
    env: process.env,
  })
  return toolAnswer(run, (r) => {
    try {
      const value = JSON.parse(r.stdout.trim()) as unknown
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // 下で名前を挙げて投げる
    }
    throw new Unanswerable(`道具が終了の状態 0 で JSON 1 つの応答を出さなかった: ${r.stdout.trim().slice(0, 200)}`)
  })
}

/**
 * 作業場所を作り、前提をそろえ、道具を回し、影の根を片付ける。
 * @implements REQ-568, REQ-570
 */
export async function inPlace(line: ExampleLine, script: string, prepare: (place: Place) => Promise<void>): Promise<Answer> {
  const place = await makePlace()
  try {
    await prepare(place)
    return await runEntry(place, script, line)
  } finally {
    await place.shadow.cleanup()
  }
}

/** 正しい 2×2 の PNG（図の画像の前提に置く）。 */
export const PNG_2X2 = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0, 253, 212, 154, 115, 0, 0, 0, 16, 73, 68,
  65, 84, 120, 156, 99, 248, 207, 192, 0, 68, 12, 16, 10, 0, 31, 238, 3, 253, 139, 95, 20, 212, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])

/** XML として整うが図でない物（PNG に描けない図の前提）。 */
export const NOT_A_FIGURE = '<?xml version="1.0" encoding="UTF-8"?>\n<note>これは図ではない</note>\n'
