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
import { withoutStorage } from './lib/storage'
import { CHECK_INTERVAL_MS, checkForUpdate, rememberBuild } from './lib/version'
import { exam } from './exam'

// @implements REQ-190, REQ-195
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

  // タブの段が学びの名前・アカウントと別の段に並ぶ狭い画面でだけ、下へ読み進めるあいだヘッダーを縮め、タブの段だけを残す。
  // 直前の読み位置から少しでも上へ動くと元に戻す。広い画面では縮めず、縮んだまま広がったら元に戻す。
  // 縮める量はタブの段より上の高さ
  // アカウントのメニューを開いている間とタブの段の外にフォーカスがある間は、下へ動いても縮む状態にせず、
  // 下へ動き続けている区間の起点もその位置に置き直す。だから止める条件が解けた瞬間には縮まず、
  // 解けたあとに下へ読み進めたときに縮む。
  // メニューを閉じた後にメニューを開くボタンに残ったフォーカスは縮むのを止めない。縮むときにタブの段の外に
  // フォーカスがあれば、縮んで操作できなくなる部品と一緒に失われないよう本文の先頭（main）へ移す
  // @implements BR-046, REQ-425, REQ-426, REQ-431, REQ-432
  const headerRef = useRef<HTMLElement | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const accountBtnRef = useRef<HTMLButtonElement | null>(null)
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  /** タブの段が別の段に並んでいるか（狭い画面か） */
  const [stacked, setStacked] = useState(false)
  /** タブの段の外（縮むと操作できなくなる部品）にフォーカスがあるか。タブの段の中のフォーカスと、
   *  メニューを閉じた後にメニューを開くボタンに残ったフォーカスは数えない */
  const [outsideFocused, setOutsideFocused] = useState(false)
  const keepFull = menuOpen || outsideFocused
  /** 読み位置の監視（effect の外）から、縮むのを止める条件を読むための写し */
  const keepFullRef = useRef(keepFull)
  useEffect(() => {
    keepFullRef.current = keepFull
    if (keepFull) setHeaderCollapsed(false)
  }, [keepFull])
  const menuOpenRef = useRef(menuOpen)
  /** 今のフォーカスが、ヘッダーの中のタブの段の外の部品にあるか */
  const focusOutsideTabs = () => {
    const active = document.activeElement
    return !!active && !!headerRef.current?.contains(active) && !navRef.current?.contains(active)
  }
  // メニューを閉じたときは、閉じる前の知らせではなく今のフォーカスの位置で決め直す。
  // メニューの項目は閉じると消え、フォーカスは focusout を出さずに文書の外へ落ちることがある。
  // メニューを開くボタンに残ったフォーカスは数えない
  const menuWasOpen = useRef(menuOpen)
  useEffect(() => {
    menuOpenRef.current = menuOpen
    if (menuWasOpen.current && !menuOpen)
      setOutsideFocused(focusOutsideTabs() && document.activeElement !== accountBtnRef.current)
    menuWasOpen.current = menuOpen
  }, [menuOpen])
  const shrunk = stacked && headerCollapsed && !keepFull
  useEffect(() => {
    const header = headerRef.current
    const nav = navRef.current
    if (!header || !nav) return
    let isStacked = false
    const measure = () => {
      const lift = Math.max(0, Math.round(nav.getBoundingClientRect().top - header.getBoundingClientRect().top) - 4)
      isStacked = lift > 12
      header.style.setProperty('--header-lift', `${isStacked ? lift : 0}px`)
      setStacked(isStacked)
      if (!isStacked) setHeaderCollapsed(false)
    }
    measure()
    let lastY = window.scrollY
    // 下へ動き続けている区間の起点。下へは起点から 6px を超えて進んだときに縮める
    let downFrom = lastY
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const y = window.scrollY
        // タブの段の外のフォーカスによる止めは、そのフォーカスが今もそこにあるときだけ効かせる。
        // 部品が消えて focusout の無いままフォーカスが落ちた取り残しは、ここで解く
        const stale = keepFullRef.current && !menuOpenRef.current && !focusOutsideTabs()
        if (stale) setOutsideFocused(false)
        if (y < 48 || y < lastY || (keepFullRef.current && !stale)) {
          setHeaderCollapsed(false)
          downFrom = y
        } else if (isStacked && y > downFrom + 6) {
          // 縮むと inert になる部品にフォーカスを置いたまま縮めると、フォーカスが文書の外へ落ちる
          const active = document.activeElement
          if (active && header.contains(active) && !nav.contains(active))
            mainRef.current?.focus({ preventScroll: true })
          setHeaderCollapsed(true)
        }
        // 直前の読み位置は動くたびに更新する（少しでも上へ動いたら戻すため）
        lastY = y
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [authed, portal])

  // @implements REQ-566
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

  // 「直前に開いていた画面」を覚える（フィードバックに自動で添える）。/feedback 自身は記録しない。
  // 端末が覚えられなければ添え先を覚えていない扱いのまま、画面の移りは止めない
  // @implements REQ-146, REQ-147, REQ-242
  useEffect(() => {
    if (location.pathname.startsWith('/feedback')) return
    withoutStorage(() => setLastPage({ path: location.pathname, label: pageLabel(location.pathname) }), null)
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
  // まなびばから戻った経路ではコードを換えたトークンで取りに行く（前のトークンを添えない）
  const onCallback = location.pathname === '/sso/callback'
  useEffect(() => {
    if (authed && !onCallback) ensureGlossary()
  }, [authed, onCallback])

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

  // まなびばから戻ってきた経路。端末のトークンの有無を問わず、コードを換えてからホームへ
  if (location.pathname === '/sso/callback') {
    return (
      <main>
        <SsoCallback onDone={() => { setAuthed(true); navigate('/', { replace: true }) }} />
      </main>
    )
  }

  // @implements REQ-190, REQ-195
  if (!authed) {
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
      {/* 縮んでいる間は、タブの段の外を画面の外へ送るだけでなく読み上げとキーボードからも外す。
          アカウントのメニューを開いている間と、タブの段の外の部品にフォーカスがある間は縮めない */}
      {/* @implements BR-046, REQ-425, REQ-426, REQ-431, REQ-432 */}
      <header
        ref={headerRef}
        className={shrunk ? 'header header-collapsed' : 'header'}
        onFocus={(e) => setOutsideFocused(!navRef.current?.contains(e.target as Node))}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOutsideFocused(false)
        }}
      >
        <div className="header-inner">
          <span className="brand" inert={shrunk} aria-hidden={shrunk || undefined}>
            {exam.brand}
          </span>

          {/* まなびば（入口）へ戻る。SSO が有効なときだけ出す */}
          {portal && (
            <a className="portal-link" href={portal} inert={shrunk} aria-hidden={shrunk || undefined}>
              ← まなびば
            </a>
          )}

          {/* ログアウトはナビに並べない。スマホではナビが横スクロールするため、
              移動のつもりで触ってログアウトしてしまう。メニューに畳んで2手にする。 */}
          <div
            className="account"
            inert={shrunk}
            aria-hidden={shrunk || undefined}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              ref={accountBtnRef}
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
      {/* 縮むヘッダーから移すフォーカスの受け先（本文の先頭）。Tab の順には入れない */}
      <main ref={mainRef} tabIndex={-1}>
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

