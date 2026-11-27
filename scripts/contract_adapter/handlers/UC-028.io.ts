/**
 * UC-028 の道具の中の読み書きの受け持ち（outbound の read…・write… の 9 操作）。
 *
 * 入口（CLAUDE.md の「操作 → 入口」の「道具の中の読み書き」、ADR-0013）: `@operation UC-028#<操作名>` を持つ
 * `scripts/` の Python の関数（操作名の snake_case）を、request の欄をキーワード引数にして呼ぶ（kit/py.ts）。
 * 作業ディレクトリは実例ごとの作業場所（kit/ta.ts の w/）。契約のパスは相対なら作業ディレクトリが起点。登録簿はリポジトリの物。
 *
 * 前提（実例ごとに作る。契約の操作の定義・errors の when・例の名前から導く）:
 * - 資格対策の学び ip の置き場（前置き無しの data/ip）は、契約の ok の例が示す中身だけの世界として書く。
 *   ファイルの置き場所と、例が挙げない欄の値はリポジトリの data/ip の同じファイルから採る
 *   （単元の構成 unit_plans/21.json・論点の一覧 topics.json・書き直した世代 materials_v4/21-1.json・図の仕様 material_figures/369.json・
 *   用語集の元 glossary_overrides.json）。
 * - 作り物の置き場 tests/fixtures/unit-reading/<名前>/ は、例の名前の条件に当たるファイルを JSON として読めない中身で置いて作る
 *   （作り物の名前が名指すファイル。図を描けない作り物は図の画像を図でない XML にする）。
 * - 図の画像はリポジトリの public/figures/materials/ip の写し。出力先は置かない。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineHandler, Unanswerable, type ExampleLine } from '../kit/protocol'
import { NOT_A_FIGURE, type Place } from '../kit/ta'
import { BROKEN_JSON, ioEntry } from '../kit/ta2'
import { REPO_ROOT } from '../kit/tool'

type Json = any

const IP = 'data/ip'
const FIXTURES = 'tests/fixtures/unit-reading'

const repoJson = async (rel: string): Promise<Json> => JSON.parse(await readFile(join(REPO_ROOT, rel), 'utf8'))

/** 単元 21 の単元の構成を、契約の readReadingUnitPlan の ok の例が示す 1 つのまとまりと前提に絞って書く。 */
async function unitPlan(p: Place): Promise<void> {
  const plan = await repoJson(`${IP}/unit_plans/21.json`)
  const group = (plan.groups as Json[])[0]
  const inGroup = new Set<number>(group.topics)
  await p.writeJson(`${IP}/unit_plans/21.json`, {
    ...plan,
    groups: [group],
    owners: ((plan.owners ?? []) as Json[])
      .filter((o) => inGroup.has(o.owner))
      .map((o) => ({ ...o, topics: (o.topics as number[]).filter((t) => inGroup.has(t)) })),
    prerequisites: { '278': [369] },
  })
}

/** 論点の一覧を、契約の readReadingTopics の ok の例が示す論点 369 だけにして書く。 */
async function topics(p: Place): Promise<void> {
  const list = await repoJson(`${IP}/topics.json`)
  const kept = (list.topics as Json[]).filter((t) => t.id === 369)
  await p.writeJson(`${IP}/topics.json`, { ...list, topic_count: kept.length, question_count: kept[0]?.question_count ?? 0, topics: kept })
}

/** 書き直した世代に、契約の readReadingDeliveredBody の ok の例が示す論点 369 の教材だけを書く。 */
async function delivered(p: Place): Promise<void> {
  const bundle = await repoJson(`${IP}/materials_v4/21-1.json`)
  const entry = (bundle.materials as Json[]).find((m) => m.topic_id === 369)
  if (!entry) throw new Unanswerable('前提を作れない: リポジトリの materials_v4/21-1.json に論点 369 が無い')
  await p.writeJson(`${IP}/materials_v4/21-1.json`, {
    ...bundle,
    materials: [{ ...entry, explanation: '**関係データベース**は…', detail: '### 表・レコード・フィールド\n…' }],
  })
}

/** 用語集の元を、契約の readReadingGlossary の ok の例が示す 1 語だけにして書く（ほかの元は置かない）。 */
async function glossary(p: Place): Promise<void> {
  await p.writeJson(`${IP}/glossary_overrides.json`, {
    関係データベース: '表の形でデータを持ち、キーの値で表どうしをつなぐデータベース',
  })
}

/** 論点 369 の図の仕様を、契約の readReadingFigureSpec の ok の例が示す差し込み位置と説明文にして書く。 */
async function figureSpec(p: Place): Promise<void> {
  const spec = await repoJson(`${IP}/material_figures/369.json`)
  const captions: Record<number, { after: string; caption: string }> = {
    1: {
      after: '### 表・レコード・フィールド',
      caption: '外から内へ単位が細かくなる入れ子です。データベースは表の、表はレコードの、レコードはフィールドの集まりです。',
    },
    2: {
      after: '### 表どうしを項目の値でつなぐ',
      caption: '左が受注表の行、右が顧客表の行です。同じ顧客番号の値で結ぶので、氏名と住所は顧客表に 1 回だけ書けば済みます。',
    },
  }
  await p.writeJson(`${IP}/material_figures/369.json`, {
    ...spec,
    figures: (spec.figures as Json[]).filter((f) => captions[f.id]).map((f) => ({ ...f, ...captions[f.id] })),
  })
}

/** 前置き無しの ip の置き場（契約の ok の例が示す中身）と図の画像。 */
async function ipWorld(p: Place): Promise<void> {
  await unitPlan(p)
  await topics(p)
  await delivered(p)
  await glossary(p)
  await figureSpec(p)
  await p.copyFromRepo('public/figures/materials/ip/369-1.svg')
  await p.copyFromRepo('public/figures/materials/ip/369-2.svg')
}

/** 作り物の名前 → 読めない中身で置くファイル（作り物の置き場の根からの相対）。 */
const UNREADABLE: Record<string, string> = {
  'unit-plan-unreadable': `${IP}/unit_plans/21.json`,
  'topics-unreadable': `${IP}/topics.json`,
  'materials-unreadable': `${IP}/materials_v4/21-1.json`,
  'glossary-unreadable': `${IP}/glossary_overrides.json`,
  'figure-spec-unreadable': `${IP}/material_figures/369.json`,
}

/** request の data か root が名指す作り物を作る。 */
async function fixture(p: Place, line: ExampleLine): Promise<void> {
  for (const value of [line.request?.data, line.request?.root]) {
    const m = typeof value === 'string' ? new RegExp(`^(${FIXTURES}/([a-z0-9-]+))(?:/|$)`).exec(value) : null
    if (!m) continue
    const [, root, name] = m
    if (name === 'figure-not-drawable') {
      await p.write(`${root}/public/figures/materials/ip/32-1.svg`, NOT_A_FIGURE)
      return
    }
    const file = UNREADABLE[name]
    if (!file) throw new Unanswerable(`${line.operation}.${line.case}: 作り物 ${name} の作り方を決められない`)
    await p.write(`${root}/${file}`, BROKEN_JSON)
    return
  }
}

const none = async () => {}
const ip = async (p: Place) => ipWorld(p)

/**
 * @implements REQ-567, REQ-570, REQ-579
 */
export default defineHandler({
  uc: 'UC-028',
  parallel: true,
  operations: {
    readReadingRegistry: ioEntry({ ok: none, roadmap: none, missing: none }),
    readReadingUnitPlan: ioEntry({ ok: ip, missing: ip, unreadable: fixture }),
    readReadingTopics: ioEntry({ ok: ip, unreadable: fixture }),
    readReadingDeliveredBody: ioEntry({ ok: ip, unreadable: fixture }),
    readReadingGlossary: ioEntry({ ok: ip, unreadable: fixture }),
    readReadingFigureSpec: ioEntry({ ok: ip, none: ip, unreadable: fixture }),
    readReadingFigure: ioEntry({ ok: ip, missing: ip }),
    writeUnitReading: ioEntry({ ok: ip }),
    writeReadingFigure: ioEntry({ notDrawable: fixture, ok: ip }),
  },
})
