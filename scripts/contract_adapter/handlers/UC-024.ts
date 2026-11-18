/**
 * UC-024 の受け持ち（単元の構成の門 checkUnitPlans ＝ `python3 scripts/check_unit_plans.py --data <学びの置き場>`）。
 * 前提は実例の名前ごとに影の根へ作る（kit/tb.ts）。
 * - pass（ip）: 単元 21・22 に論点が 52 ずつ。どちらも 8・8・8・8・8・8・4 のまとまりで、止める理由にも警告にも当たらない
 * - passWithoutPlans（fe）: シラバスと論点の一覧はあり、単元の構成は 1 つも無い
 * - stopped（ap）: 単元 9 に論点 1〜41。まとまりは 8・8・9・7・7・2（3 番目が上限超え、6 番目が下限未満）
 * - stoppedDuplicatePrerequisite（ap）: 単元 9 に論点 1〜41。まとまりは 8・8・8・8・6・3 で、論点 12 の前提に論点 5 が 2 回並ぶ
 * - unknownLearning（zzz）・notQualification（itc）: 置き場はあり、単元の構成は壊れている
 * - syllabusMissing（fe）: 論点の一覧はあり、シラバスが無い
 * - syllabusUnreadable（ap）: シラバスが JSON として読めない
 */

import { defineHandler, Unanswerable } from '../kit/protocol'
import { answerOf, chunk, inShadow, keyOf, planOf, planPath, range, removeFile, runScript, writeLearning, writePlan, type Learning, type SyllabusUnit } from '../kit/tb'
import type { Shadow } from '../kit/tool'

const topicsOf = (ids: number[], item: number) => ids.map((id) => ({ id, term: `論点${id}`, item }))

const UNIT_21: SyllabusUnit = { no: 21, name: '単元二十一', items: [1] }
const UNIT_22: SyllabusUnit = { no: 22, name: '単元二十二', items: [2] }
const UNIT_9: SyllabusUnit = { no: 9, name: '単元九', items: [9] }

/** ip の仕込み（pass）。 */
async function ipClean(shadow: Shadow, key: string) {
  const t21 = range(1001, 52)
  const t22 = range(2001, 52)
  const learning: Learning = { units: [UNIT_21, UNIT_22], topics: [...topicsOf(t21, 1), ...topicsOf(t22, 2)] }
  await writeLearning(shadow, key, learning)
  const sizes = [8, 8, 8, 8, 8, 8, 4]
  await writePlan(shadow, key, planOf(UNIT_21, chunk(t21, sizes)))
  await writePlan(shadow, key, planOf(UNIT_22, chunk(t22, sizes)))
}

/** 単元 9 に論点 1〜41 を持つ学び。 */
async function unit9(shadow: Shadow, key: string) {
  const ids = range(1, 41)
  await writeLearning(shadow, key, { units: [UNIT_9], topics: topicsOf(ids, 9) })
  return ids
}

/** 置き場はあるが単元の構成が書きかけの学び（登録簿で断られる学び）。 */
async function brokenPlanLearning(shadow: Shadow, key: string) {
  await writeLearning(shadow, key, { units: [UNIT_21], topics: topicsOf(range(1001, 3), 1) })
  await shadow.write(planPath(key, 21), '{"unit_no": 21,')
}

const PRECONDITIONS: Record<string, (shadow: Shadow, key: string) => Promise<void>> = {
  pass: ipClean,
  passWithoutPlans: async (shadow, key) => {
    await writeLearning(shadow, key, { units: [UNIT_21], topics: topicsOf(range(1001, 5), 1) })
  },
  stopped: async (shadow, key) => {
    const ids = await unit9(shadow, key)
    await writePlan(shadow, key, planOf(UNIT_9, chunk(ids, [8, 8, 9, 7, 7, 2])))
  },
  stoppedDuplicatePrerequisite: async (shadow, key) => {
    const ids = await unit9(shadow, key)
    await writePlan(shadow, key, planOf(UNIT_9, chunk(ids, [8, 8, 8, 8, 6, 3]), { '12': [5, 5] }))
  },
  unknownLearning: brokenPlanLearning,
  notQualification: brokenPlanLearning,
  syllabusMissing: async (shadow, key) => {
    await writeLearning(shadow, key, { units: [UNIT_21], topics: topicsOf(range(1001, 5), 1) })
    await removeFile(shadow, `data/${key}/syllabus.json`)
  },
  syllabusUnreadable: async (shadow, key) => {
    await unit9(shadow, key)
    await shadow.write(`data/${key}/syllabus.json`, '{"items": [')
  },
}

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-024',
  parallel: true,
  operations: {
    checkUnitPlans: async (line) => {
      const prepare = PRECONDITIONS[line.case]
      if (!prepare) throw new Unanswerable(`UC-024 checkUnitPlans の例 ${line.case} の前提を知らない`)
      const key = keyOf(line.request)
      return inShadow(async (shadow) => {
        await prepare(shadow, key)
        return answerOf(await runScript(shadow, 'check_unit_plans.py', ['--data', `data/${key}`]), [0, 1])
      })
    },
  },
})
