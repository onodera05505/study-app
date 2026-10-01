import { Link } from 'react-router-dom'

/** 画面左上の戻るボタン。
 *
 *  ブラウザの履歴を戻すのではなく、**行き先を明示**する。履歴を戻すと、
 *  直接URLを開いたときや、演習から結果画面に来たときに、どこへ戻るのか
 *  予測できない。「どこへ戻るか」をラベルに出しておけば迷わない。
 *
 *  タップ領域は 44px を確保する。片手操作で最初に触る場所になるため。 */
// @implements-old REQ-055
// @implements BR-016
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="back">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M15 5 8 12l7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{label}</span>
    </Link>
  )
}
