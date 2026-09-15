import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { clearToken, getToken } from './lib/api'
import { ensureGlossary } from './lib/glossary'
import { Login } from './pages/Login'
import { Home } from './pages/Home'
import { Topics } from './pages/Topics'
import { TopicDetail } from './pages/TopicDetail'
import { Practice } from './pages/Practice'
import { Exams } from './pages/Exams'
import { Session } from './pages/Session'
import { Result } from './pages/Result'
import { History } from './pages/History'
import { exam } from './exam'

export function App() {
  const [authed, setAuthed] = useState(!!getToken())
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()

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
              アカウント
            </button>
            {menuOpen && (
              <div className="account-menu" role="menu">
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
          </nav>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/topics" element={<Topics />} />
          <Route path="/topics/:id" element={<TopicDetail />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/exams" element={<Exams />} />
          <Route path="/sessions/:id" element={<Session />} />
          <Route path="/sessions/:id/result" element={<Result />} />
          <Route path="/history" element={<History />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  )
}
