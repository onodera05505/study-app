/** テストの種別（sessions.kind）の表示名。
 *
 *  ホームと履歴で別々に持っていたため、同じ `middle` が「単元演習」と
 *  「中分類演習」の2通りに出ていた。「中分類」はシラバスの用語で学習者には
 *  通じないので、画面では「単元」で通す（Topics.tsx と同じ判断）。
 *  種別の名前を足すときはここだけ直す。 */
export const KIND_LABEL: Record<string, string> = {
  drill: '論点ドリル',
  field: '分野別演習',
  middle: '単元演習',
  review: '弱点復習',
  mock: '過去問実践',
}
