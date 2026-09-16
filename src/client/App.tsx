import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { clearToken, getToken, getUserName } from './lib/api'
import { ensureGlossary } from './lib/glossary'
import { Login } from './pages/Login'
import { Home } from './pages/Home'
import { Topics } from './pages/Topics'
import { Roadmap } from './pages/Roadmap'
import { TopicDetail } from './pages/TopicDetail'
import { Practice } from './pages/Practice'
import { Exams } from './pages/Exams'
import { Session } from './pages/Session'
import { Result } from './pages/Result'
import { History } from './pages/History'
import { Feedback } from './pages/Feedback'
import { setLastPage } from './lib/lastPage'
import { exam } from './exam'

export function App() {
  const [authed, setAuthed] = useState(!!getToken())
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  // 「直前に開いていた画面」を覚える（フィードバックに自動で添える）。/feedback 自身は記録しない
  useEffect(() => {
    if (location.pathname.startsWith('/feedback')) return
    setLastPage({ path: location.pathname, label: pageLabel(location.pathname) })
  }, [location.pathname])

  // アカウントメニューは、外側を触るか Esc で閉じる
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // 用語集は本文を描くときに要る。画面を開いてから取りにいくと、`[[用語]]` が
  // 一瞬ただの文字で出てから色が付く。ログインした時点で先に取っておく。
  useEffect(() => {
    if (authed) ensureGlossary()
  }, [authed])

  // 401 でトークンが破棄されたら、どの画面からでもログインに戻す
  useEffect(() => {
    const check = () => setAuthed(!!getToken())
    window.addEventListener('storage', check)
    const id = setInterval(check, 2000)
    return () => {
      window.removeEventListener('storage', check)
      clearInterval(id)
    }
  }, [])

  if (!authed) {
    return (
      <main>
        <Login onDone={() => setAuthed(true)} />
      </main>
    )
  }

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <span className="brand">{exam.brand}</span>

          {/* ログアウトはナビに並べない。スマホではナビが横スクロールするため、
              移動のつもりで触ってログアウトしてしまう。メニューに畳んで2手にする。 */}
          <div className="account" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="account-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {getUserName() ?? 'アカウント'}
            </button>
            {menuOpen && (
              <div className="account-menu" role="menu">
                <p className="account-name">
                  {getUserName() ?? 'ログイン中'} としてログイン中
                </p>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    clearToken()
                    setAuthed(false)
                    navigate('/')
                  }}
                >
                  ログアウト
                </button>
              </div>
            )}
          </div>

          <nav className="nav">
            <NavLink to="/" end>ホーム</NavLink>
            <NavLink to="/topics">学習</NavLink>
            <NavLink to="/practice">練習テスト</NavLink>
            <NavLink to="/exams">{exam.words.mock}</NavLink>
            <NavLink to="/history">履歴</NavLink>
            <NavLink to="/feedback">フィードバック</NavLink>
          </nav>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/topics" element={exam.roadmap ? <Roadmap /> : <Topics />} />
          <Route path="/topics/:id" element={<TopicDetail />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/exams" element={<Exams />} />
          <Route path="/sessions/:id" element={<Session />} />
          <Route path="/sessions/:id/result" element={<Result />} />
          <Route path="/history" element={<History />} />
          <Route path="/feedback" element={<Feedback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}

/** パスから人が読む画面名を出す。論点名・問題 ID は各画面が分かった時点で annotateLastPage で足す。 */
function pageLabel(path: string): string {
  if (path === '/') return 'ホーム'
  if (path.startsWith('/topics/')) return '学習の単位'
  if (path.startsWith('/topics')) return exam.roadmap ? 'ロードマップ' : '学習の一覧'
  if (path.startsWith('/practice')) return '練習テスト'
  if (path.startsWith('/exams')) return exam.words.mock
  if (path.startsWith('/sessions/') && path.endsWith('/result')) return 'テストの結果'
  if (path.startsWith('/sessions/')) return 'テスト中の問題'
  if (path.startsWith('/history')) return '履歴'
  return path
}

