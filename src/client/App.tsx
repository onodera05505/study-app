import { useEffect, useRef, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, clearToken, getToken, getUserName } from './lib/api'
import { ensureGlossary } from './lib/glossary'
import { Login } from './pages/Login'
import { SsoCallback } from './pages/SsoCallback'
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
import { CHECK_INTERVAL_MS, checkForUpdate, rememberBuild } from './lib/version'
import { exam } from './exam'

// @implements REQ-031, REQ-032, REQ-038, REQ-053
export function App() {
  const [authed, setAuthed] = useState(!!getToken())
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)
  // 入口（まなびば）の URL。SSO が有効な環境だけ返る
  const [portal, setPortal] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // ナビがスマホ幅で収まらないとき、右端をぼかして「続きがある」と分かるようにする
  // （資格版は 6 項目あり、iPhone 幅で最後の「フィードバック」が切れて見えるだけだった。本人 2026-09-18）
  const navRef = useRef<HTMLElement | null>(null)
  const [navScroll, setNavScroll] = useState(false)
  useEffect(() => {
    const el = navRef.current
    if (!el) return
    const check = () => setNavScroll(el.scrollWidth > el.clientWidth + 1)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  })

  useEffect(() => {
    // 入口の URL は公開の設定から取る（学び側は SSO_PORTAL_URL を知っているが、画面には焼き込まない）
    api<{ sso: boolean; portal: string | null }>('/auth/config')
      .then((c) => setPortal(c.sso ? c.portal : null))
      .catch(() => setPortal(null))
  }, [])

  // 新しい版の検知（要件 §5.6）。最初に版を覚え、画面を移るときと 5 分おきに見比べる
  useEffect(() => {
    rememberBuild()
    const id = setInterval(() => {
      checkForUpdate().then((v) => v && setUpdateReady(true))
    }, CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    checkForUpdate().then((v) => v && setUpdateReady(true))
  }, [location.pathname])

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
    // まなびばから戻ってきた（要件 §15）。コードをトークンに換えてからホームへ
    if (location.pathname === '/sso/callback') {
      return (
        <main>
          <SsoCallback onDone={() => { setAuthed(true); navigate('/', { replace: true }) }} />
        </main>
      )
    }
    return (
      <main>
        <Login onDone={() => setAuthed(true)} />
      </main>
    )
  }

  return (
    <>
      {updateReady && (
        <div className="update-bar" role="status">
          <span>新しい版があります。</span>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            更新
          </button>
        </div>
      )}
      <header className="header">
        <div className="header-inner">
          <span className="brand">{exam.brand}</span>

          {/* まなびば（入口）へ戻る。SSO が有効なときだけ出す。本人の依頼 2026-09-18 */}
          {portal && (
            <a className="portal-link" href={portal}>
              ← まなびば
            </a>
          )}

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

          {/* ロードマップ型は「ロードマップ」「フィードバック」の 2 つだけ（要件 §13.6、2026-09-18 決定）。
              1 単位 2 問しかなく、同じ問題が単位の下にあるので、練習テストとドリルは重複だった。
              確認テストは日ごとにロードマップの中へ、履歴は各日の結果表示へ移した。資格版は据え置き。 */}
          <nav className={navScroll ? 'nav nav-scroll' : 'nav'} ref={navRef}>
            {exam.roadmap ? (
              <>
                <NavLink to="/topics">ロードマップ</NavLink>
                <NavLink to="/feedback">フィードバック</NavLink>
              </>
            ) : (
              <>
                <NavLink to="/" end>ホーム</NavLink>
                <NavLink to="/topics">学習</NavLink>
                <NavLink to="/practice">練習テスト</NavLink>
                <NavLink to="/exams">{exam.words.mock}</NavLink>
                <NavLink to="/history">履歴</NavLink>
                <NavLink to="/feedback">フィードバック</NavLink>
              </>
            )}
          </nav>
        </div>
      </header>
      <main>
        <Routes>
          {/* ロードマップ型にホームは無い（要件 §13.6）。進捗と続きはロードマップの先頭に出す */}
          <Route path="/" element={exam.roadmap ? <Navigate to="/topics" replace /> : <Home />} />
          <Route path="/topics" element={exam.roadmap ? <Roadmap /> : <Topics />} />
          <Route path="/topics/:id" element={<TopicDetail />} />
          <Route path="/practice" element={exam.roadmap ? <Navigate to="/topics" replace /> : <Practice />} />
          <Route path="/exams" element={exam.roadmap ? <Navigate to="/topics" replace /> : <Exams />} />
          <Route path="/sessions/:id" element={<Session />} />
          <Route path="/sessions/:id/result" element={<Result />} />
          <Route path="/history" element={exam.roadmap ? <Navigate to="/topics" replace /> : <History />} />
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

