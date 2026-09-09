/** 選択肢1つぶんの解説。誤答なら「何の用語の説明か」（term）と1行の説明（note）。
 *  正解の行は term が null でよく、note は「正解。〜」の形で書かれている。 */
export type ExplanationChoice = { label: string; term: string | null; note: string }

/** 問題ごとの解説。論点の教材（定義・見分け方）に対して、こちらは
 *  「この問題でなぜその選択肢なのか」と「誤答が何の説明か」を持つ。 */
export type Explanation = { correctReason: string; choices: ExplanationChoice[] }

/** 解説を引くための列。過去問と同じ SELECT に混ぜて取る。
 *
 *  **問題ごとに引かない。** 結果画面は最大100問あるので、1問ずつ引くと D1 の
 *  往復が100回になる（1往復 0.2〜0.4 秒）。content_key は past_questions の列なので、
 *  過去問を引くクエリに LEFT JOIN すれば往復は増えない。
 *
 *  JOIN の相手は主キー（content_key）なので、行が増えることはない。 */
export type ExplanationColumns = {
  explCorrectReason: string | null
  explChoicesJson: string | null
}

/** 取れた列を画面に返す形にする。
 *
 *  壊れた JSON で画面ごと落とさない。解説が出ないだけにする（解説はまだ全問には
 *  無く、途中状態でも画面が壊れないことが要件）。 */
export function explanationOf(row: ExplanationColumns): Explanation | null {
  if (!row.explCorrectReason || !row.explChoicesJson) return null
  try {
    const choices = JSON.parse(row.explChoicesJson)
    if (!Array.isArray(choices)) return null
    return { correctReason: row.explCorrectReason, choices }
  } catch {
    return null
  }
}
