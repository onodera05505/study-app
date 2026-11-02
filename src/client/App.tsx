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

export function App() {
  const [authed, setAuthed] = useState(!!getToken())
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)
  // 入口（まなびば）の URL。SSO が有効な環境だけ返る
  const [portal, setPortal] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // ナビがスマホ幅で収まらないとき、右端をぼかして「続きがある」と分かるようにする
  // （資格版は項目が 6 つあり、スマホ幅では最後の項目が端で切れて見える）
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

  // 新しい版の検知。開いたときに版の印を 1 回だけ覚え、その時点では見比べない。
  // 見比べるのは画面を移ったときと 5 分おき。
  // @implements REQ-227, REQ-228, REQ-230
  useEffect(() => {
    rememberBuild()
    const id = setInterval(() => {
      checkForUpdate().then((v) => v && setUpdateReady(true))
    }, CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])
  // 覚えているのは「最後に見たパス」。開いた直後は同じなので見比べず、移るたびに見比べる
  // @implements REQ-229
  const seenPath = useRef(location.pathname)
  useEffect(() => {
    if (location.pathname === seenPath.current) return
    seenPath.current = location.pathname
    checkForUpdate().then((v) => v && setUpdateReady(true))
  }, [location.pathname])

  // 「直前に開いていた画面」を覚える（フィードバックに自動で添える）。/feedback 自身は記録しない
  // @implements REQ-146, REQ-147
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

  // @implements REQ-190, REQ-195
  if (!authed) {
    // まなびばから戻ってきた経路。コードをトークンに換えてからホームへ
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
      {/* @implements REQ-234, REQ-235, REQ-236 */}
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

          {/* まなびば（入口）へ戻る。SSO が有効なときだけ出す */}
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
                {/* @implements REQ-198 */}
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

          {/* ロードマップ型は「ロードマップ」「フィードバック」の 2 つだけ。
              1 単位 2 問しかなく、同じ問題が単位の下にあるので、練習テストとドリルは重複になる。
              確認テストは日ごとにロードマップの中、履歴は各日の結果表示に出す。資格版は 6 項目を出す。 */}
          {/* @implements REQ-128, REQ-150 */}
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
        {/* @implements REQ-128, REQ-195 */}
        <Routes>
          {/* ロードマップ型にホームは無い。進捗と続きはロードマップの先頭に出す */}
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
// @implements REQ-146
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

