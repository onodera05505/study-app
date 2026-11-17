/** 過去問が回と問番号の組で 1 つに保たれ、回を選んだ模試（startSession ＝ POST /api/sessions の kind: mock）に
 *  問番号ごとに 1 問だけが並ぶこと（UC-008）。
 *
 *  D1 は migrations を当てた本物の SQLite（sessions_sqlite_fixture.ts）。2 つ目の過去問の保存は SQLite に直接当て、
 *  観測は保存の成否と、契約の操作（startSession・getCurrentQuestion・answerQuestion）で出る問題の並び。 */

import { describe, expect, it } from 'vitest'
import { answerCurrent, countOf, currentOk, openWorld, seedQuestions, startOk } from './sessions_sqlite_fixture'
import targets from '../../src/shared/targets.json'

const LEARNING = 'ip'
const FIELD = (targets as unknown as Record<string, { fields: string[] }>)[LEARNING].fields[0]
const EXAM = '2024r06'

describe('同じ回に同じ問番号の過去問を 2 つ目として保存しようとしたとき（UC-008）', () => {
  // @covers REQ-106#one-question-per-number
  it('2 つ目は保存されず、その回を選んだ模試には問番号ごとに 1 問だけが問番号の昇順で並ぶ', async () => {
    const w = await openWorld(LEARNING)
    const ids = seedQuestions(w, EXAM, 3, FIELD)
    const insertQuestion = (id: string, exam: string, number: number) =>
      w.db
        .prepare(
          `INSERT INTO past_questions (id, exam, exam_label, number, text, choices, answer, citation, content_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, exam, exam, number, `${id} の本文`, JSON.stringify({ ア: 'a', イ: 'b', ウ: 'c', エ: 'd' }), 'ア', `出典：${exam} 問${number}`, `ck-${id}`)

    // 空振り対策: 同じ文で、別の回なら同じ問番号の過去問を保存できる
    expect(() => insertQuestion('2023r05-q2', '2023r05', 2), '同じ文で別の回の過去問が保存できない（この検査は空振りになる）').not.toThrow()

    expect(() => insertQuestion(`${EXAM}-dup2`, EXAM, 2), '同じ回に同じ問番号の過去問が 2 つ目として保存された').toThrow()
    expect(countOf(w, 'past_questions', 'exam = ? AND number = ?', EXAM, 2), '同じ回と問番号の過去問が 1 つでない').toBe(1)

    const created = await startOk(w, { kind: 'mock', exam: EXAM })
    expect(created.questionCount, '模試の問題数が回の問番号の数と違う').toBe(3)
    const texts: string[] = []
    for (let i = 0; i < created.questionCount; i++) {
      const cur = await currentOk(w, created.id)
      texts.push(cur.question!.text)
      await answerCurrent(w, created.id)
    }
    expect(texts, '問番号ごとに 1 問ずつ、問番号の昇順で並んでいない').toEqual(ids.map((id) => `${id} の本文`))
  })
})
