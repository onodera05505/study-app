import { useEffect, useState } from 'react'
import { api, setToken, takeSessionExpired } from '../lib/api'
import { exam } from '../exam'
import { portal } from '../../shared/exam'

type AuthConfig = { sso: boolean; portal: string | null; app: string }

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  // 401 で締め出されて戻って来たのかどうか。読んだ時点で印は消えるので、
  // 描き直しても増えないよう初期値としてだけ受け取る。
  const [expired] = useState(takeSessionExpired)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [signupCode, setSignupCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // SSO（まなびば。要件 §15）が設定された環境ではパスワードの欄を出さず、まなびばへ送る 1 ボタンにする。
  // null は「まだ取得していない」。取れなければ従来のフォーム（ローカルの検査用）
  const [cfg, setCfg] = useState<AuthConfig | null>(null)
  useEffect(() => {
    api<AuthConfig>('/auth/config').then(setCfg).catch(() => setCfg({ sso: false, portal: null, app: exam.key }))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body =
        mode === 'login' ? { email, password } : { email, password, name, signupCode }
      const res = await api<{ token: string }>(`/auth/${mode}`, { method: 'POST', body })
      setToken(res.token)
      onDone()
    } catch (err: any) {
      setError(err.message ?? 'エラーが発生しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <h1>{exam.brand}</h1>
      <p className="lead">
        {exam.roadmapSpec?.loginLead ?? '過去問を起点に、頻出の論点から順に潰していく学習アプリです。'}
      </p>
      {expired && (
        <div className="notice">
          ログインの有効期限が切れました。もう一度ログインしてください。
        </div>
      )}
      {cfg === null && <p className="muted">読み込み中…</p>}
      {cfg?.sso && (
        <div className="card">
          <p style={{ marginTop: 0 }}>ログインは「{portal.name}」でまとめて行います。1 つのアカウントで、権限のある学びをすべて開けます。</p>
          <a className="btn btn-primary btn-block" href={`${(cfg.portal ?? portal.url).replace(/\/$/, '')}/sso/start?app=${encodeURIComponent(cfg.app)}`}>
            {portal.name}でログイン
          </a>
          <p className="muted small" style={{ marginTop: '0.8rem' }}>アカウントは管理者が作ります。パスワードを忘れたら管理者に再設定を頼んでください。</p>
        </div>
      )}
      {cfg !== null && !cfg.sso && (
      <div className="card">
        {/* type を省くと submit 扱いになる。タブは下のフォームの外にあるが、
            将来フォームの中に入れたときに切り替えたつもりで送信されるので明示する。 */}
        <div className="tabs">
          <button
            type="button"
            className={`btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => setMode('login')}
          >
            ログイン
          </button>
          <button
            type="button"
            className={`btn ${mode === 'register' ? 'active' : ''}`}
            onClick={() => setMode('register')}
          >
            新規登録
          </button>
        </div>
        <form onSubmit={submit}>
          {mode === 'register' && (
            <label>
              <span>お名前</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          <label>
            <span>メールアドレス</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            <span>パスワード（8文字以上）</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {mode === 'register' && (
            <label>
              <span>合言葉（設定されている場合のみ）</span>
              <input value={signupCode} onChange={(e) => setSignupCode(e.target.value)} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? '送信中…' : mode === 'login' ? 'ログイン' : '登録する'}
          </button>
        </form>
        {/* 身内向けなのでパスワード再設定の仕組みは持っていない。
            行き止まりに見えないよう、代わりの手を書いておく。 */}
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.8rem 0 0' }}>
          パスワードを忘れたときは管理者に連絡してください。
        </p>
      </div>
      )}
    </div>
  )
}
