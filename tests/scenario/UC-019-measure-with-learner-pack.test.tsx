/** UC-019「学習者役のパックを作って読ませ、伝わったかを周の結果で測る」の主シナリオを
 *  1 本で実行する写し（正常系のみ。止まる場合は各要件のテストが見る）。
 *
 *  作り手の手元を一時ディレクトリに置き、そこを作業の場所にしてコマンドを呼ぶ。
 *  契約の data・out は作業の場所からの相対の道で、学びは登録簿にあるロードマップ型の eng。
 *  学びの置き場と配信の図の置き場は、eng の今のデータをそのまま写したものを使う。
 *  学習者役の答えは、パックの写しに出た問題と単位から組んだ答えのファイルで置き換える。 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '')
const DATA = 'data/eng'
const CHOICES = ['ア', 'イ', 'ウ', 'エ'] as const
const UNKNOWN_TERM = '学習者役が説明を見つけられなかった語'

type Snapshot = {
  cycle: number
  units: { order: number; topic_id: number; term: string; field: string }[]
  questions: { qid: string; topic_id: number; tests_goal: number; field: string; answer: string }[]
}

let root = ''
/** テストの前に本物の学びの置き場に無かった、この周の写しと周の結果の道。 */
let repoGuards: string[] = []

/** 学びの置き場の eval にある周の番号の最大。 */
function maxCycle(evalDir: string): number {
  if (!existsSync(evalDir)) return 0
  let max = 0
  for (const name of readdirSync(evalDir)) {
    const m = /^(?:pack_)?cycle_(\d+)\.json$/.exec(name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

/** 作業の場所でコマンドを呼び、終了コードと標準出力の JSON を返す。 */
function run(script: string, args: string[]): { status: number | null; json: unknown; stderr: string } {
  const p = spawnSync('python3', [join(REPO, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  let json: unknown = null
  try {
    json = JSON.parse(p.stdout)
  } catch {
    json = null
  }
  return { status: p.status, json, stderr: `${p.stderr ?? ''}${p.error ? String(p.error) : ''}` }
}

/** 正解とも、前後の問題の正解とも違う選択肢（記録のずれの疑いに当たらない誤答）。 */
function wrongChoice(qs: Snapshot['questions'], i: number): string {
  const avoid = new Set([qs[i].answer, qs[i - 1]?.answer, qs[i + 1]?.answer])
  return CHOICES.find((c) => !avoid.has(c)) ?? CHOICES.find((c) => c !== qs[i].answer)!
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uc019-'))
  cpSync(join(REPO, DATA), join(root, DATA), { recursive: true })
  cpSync(join(REPO, 'public/figures/materials/eng'), join(root, 'public/figures/materials/eng'), { recursive: true })
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  cpSync(join(REPO, 'src/shared/targets.json'), join(root, 'src/shared/targets.json'))
  repoGuards = []
})

afterEach(() => {
  // 作業の場所の外（本物の学びの置き場）に写しや周の結果を書いていたら、テストが作った物だけ消す
  for (const p of repoGuards) if (existsSync(p)) rmSync(p)
  // 道具が時間切れで止められた直後は、孫のプロセスがまだ書いていて消しきれないことがあるので、少し待って消し直す
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('UC-019 学習者役のパックを作って読ませ、伝わったかを周の結果で測る', () => {
  // @scenario UC-019
  it('周の番号を付けてパックを作り、学習者役の答えを同じ周の写しで採点して周の結果を受け取る', () => {
    const cycle = Math.max(maxCycle(join(REPO, DATA, 'eval')), maxCycle(join(root, DATA, 'eval'))) + 1
    const out = `learner_packs/eng_c${cycle}`
    const repoSnapshot = join(REPO, DATA, 'eval', `pack_cycle_${cycle}.json`)
    const repoResult = join(REPO, DATA, 'eval', `cycle_${cycle}.json`)
    repoGuards = [repoSnapshot, repoResult].filter((p) => !existsSync(p))

    // step 1: 作り手が、学びと周の番号と出力先を指定して学習者役のパックを作る
    const built = run('build_learner_pack.py', ['--data', DATA, '--cycle', String(cycle), '--out', out])
    expect(built.status, `パックを作れなかった: ${built.stderr}`).toBe(0)
    const pack = built.json as { snapshotPath: string; snapshot: Snapshot; files: { roadmap: string; units: string[]; quiz: string; explain?: string; figures: string[] } }
    expect(pack, 'パックを作った結果が標準出力の JSON に無い').not.toBeNull()

    // step 2: システムが、その周のパックの写しを残す
    expect(pack.snapshotPath).toBe(`${DATA}/eval/pack_cycle_${cycle}.json`)
    expect(existsSync(join(root, pack.snapshotPath)), 'その周のパックの写しが学びの置き場に残っていない').toBe(true)
    const snapshot = JSON.parse(readFileSync(join(root, pack.snapshotPath), 'utf8')) as Snapshot
    expect(snapshot.cycle).toBe(cycle)
    expect(existsSync(repoSnapshot) && repoGuards.includes(repoSnapshot), '写しを作業の場所の外の学びの置き場に書いた').toBe(false)

    // step 3: システムが、ロードマップ・単位ごとの配る本文と図・確認問題、語の一覧がある学びでは説明テストを、正解を含めずにパックへ出す
    expect(pack.files.roadmap).toBe('roadmap.md')
    expect(pack.files.quiz).toBe('quiz.md')
    expect(pack.files.explain, '語の一覧がある学びなのに説明テストが無い').toBe('explain.md')
    expect(pack.files.units.length, '単位ごとの本文がパックに無い').toBe(snapshot.units.length)
    for (const f of [pack.files.roadmap, pack.files.quiz, pack.files.explain!, ...pack.files.units, ...pack.files.figures]) {
      expect(existsSync(join(root, out, f)), `パックに ${f} が無い`).toBe(true)
    }

    // step 4: 作り手が、学びの学習者役への指示を雛形から描き出す
    const instructions = run('render_prompts.py', ['--data', DATA])
    expect(instructions.status, `学習者役への指示を描き出せなかった: ${JSON.stringify(instructions.json)} ${instructions.stderr}`).toBe(0)
    expect(instructions.json, '描き出した指示の道が標準出力の JSON に無い').toEqual({ path: `${DATA}/prompts/roadmap_learner.md` })
    const instructionsPath = (instructions.json as { path: string }).path

    // step 5: 作り手が、パックと学習者役への指示だけを学習者役に渡す（パックの出力先は学びの置き場の外）
    expect(existsSync(join(root, instructionsPath)), '学習者役に渡す指示が描き出した道に無い').toBe(true)
    expect(out.startsWith(`${DATA}/`), 'パックの出力先が学びの置き場の中にある').toBe(false)
    expect(existsSync(join(root, out)), '学習者役に渡すパックが出力先に無い').toBe(true)

    // step 6: 学習者役が、ロードマップの順に単位を読み、確認問題に答え、単位ごとの自己申告と説明テストの答えを返す（答えのファイルで置き換える）
    const [known, overconfident, lost] = snapshot.units
    const answers: Record<string, string> = {}
    snapshot.questions.forEach((q, i) => {
      if (q.topic_id === known.topic_id) answers[q.qid] = q.answer
      else if (q.topic_id === overconfident.topic_id) answers[q.qid] = wrongChoice(snapshot.questions, i)
    })
    const answersFile = join(out, 'learner_answers.json')
    writeFileSync(
      join(root, answersFile),
      JSON.stringify({
        answers,
        units: [
          { topic_id: known.topic_id, minutes: 5, understood: 3, confusing: '', unknown_terms: [] },
          { topic_id: overconfident.topic_id, minutes: 6, understood: 3, confusing: '', unknown_terms: [] },
          { topic_id: lost.topic_id, minutes: 7, understood: 1, confusing: '', unknown_terms: [UNKNOWN_TERM] },
        ],
      }),
    )

    // step 7: 作り手が、同じ周の番号を指定して学習者役の答えを採点する
    const graded = run('grade_learner.py', ['--data', DATA, '--cycle', String(cycle), '--answers', answersFile])
    expect(graded.status, `採点できなかった: ${graded.stderr}`).toBe(0)
    const result = graded.json as Record<string, any>
    expect(result, '周の結果が標準出力の JSON に無い').not.toBeNull()

    // step 8: システムが、その周のパックの写しで採点し、周の結果を残して作り手に示す
    const resultPath = join(root, DATA, 'eval', `cycle_${cycle}.json`)
    expect(existsSync(resultPath), 'その周の結果が学びの置き場に残っていない').toBe(true)
    expect(JSON.parse(readFileSync(resultPath, 'utf8')), '残した周の結果と作り手に示した周の結果が違う').toEqual(result)
    expect(existsSync(repoResult) && repoGuards.includes(repoResult), '周の結果を作業の場所の外の学びの置き場に書いた').toBe(false)

    // 成功時: その周の正答の内訳
    const knownCount = snapshot.questions.filter((q) => q.topic_id === known.topic_id).length
    expect(result.cycle).toBe(cycle)
    expect(result.score, '正答が写しの問題で数えられていない').toBe(`${knownCount}/${snapshot.questions.length}`)
    expect(Object.keys(result.by_goal).length, '到達基準ごとの正答が無い').toBeGreaterThan(0)
    expect(Object.keys(result.by_field).length, '分野ごとの正答が無い').toBeGreaterThan(0)

    // 成功時: 自己申告（写しの全単位について）
    expect(Object.keys(result.per_unit).sort(), '写しの単位が周の結果にそろっていない').toEqual(snapshot.units.map((u) => String(u.topic_id)).sort())
    expect(result.per_unit[String(known.topic_id)].understood).toBe(3)
    expect(result.per_unit[String(lost.topic_id)].understood).toBe(1)
    expect(result.reported_units).toBe(3)

    // 成功時: 詰まった単位・過信の単位・説明の無かった語
    const ids = (rows: { topic_id: number }[]) => rows.map((r) => r.topic_id)
    expect(ids(result.stuck_units), '「分からなかった」の単位が詰まった単位に無い').toContain(lost.topic_id)
    expect(ids(result.overconfident_units), '「人に説明できる」なのに間違えた単位が過信の単位に無い').toContain(overconfident.topic_id)
    expect(ids(result.overconfident_units), '全問正解の単位が過信の単位に入っている').not.toContain(known.topic_id)
    expect(result.unknown_terms, '説明の無かった語が周の結果に無い').toContain(UNKNOWN_TERM)

    // 成功時: 前の周がある学びでは前の周との差
    expect(typeof result.delta_rate, '前の周との正答率の差が無い').toBe('number')
    expect(typeof result.delta_understood, '前の周との理解の段の差が無い').toBe('number')
  }, 180_000)
})
