import { useEffect, useState } from 'react'
import { api, takeSessionExpired } from '../lib/api'
import { exam } from '../exam'
import { portal } from '../../shared/exam'

type AuthConfig = { sso: boolean; portal: string | null; app: string }

/** ログイン画面。まなびばへの導線だけを置き、学び側のパスワードと登録の入力の欄はどの配備でも出さない。 */
// @implements REQ-190, REQ-204
export function Login(_props: { onDone: () => void }) {
  // 401 で締め出されて戻って来たのかどうか。読んだ時点で印は消えるので、
  // 描き直しても増えないよう初期値としてだけ受け取る。
  const [expired] = useState(takeSessionExpired)
  // null は「まだ取得していない」。取れなければ登録簿のまなびばの場所へ送る
  const [cfg, setCfg] = useState<AuthConfig | null>(null)
  useEffect(() => {
    api<AuthConfig>('/auth/config').then(setCfg).catch(() => setCfg({ sso: false, portal: null, app: exam.key }))
  }, [])

  // @implements REQ-525
  const base = ((cfg?.sso ? cfg.portal : null) ?? portal.url).replace(/\/$/, '')

  return (
    <div className="center">
      <h1>{exam.brand}</h1>
      <p className="lead">
        {exam.roadmapSpec?.loginLead ?? '過去問を起点に、頻出の論点から順に潰していく学習アプリです。'}
      </p>
      {/* @implements REQ-197 */}
      {expired && (
        <div className="notice">
          ログインの有効期限が切れました。もう一度ログインしてください。
        </div>
      )}
      {cfg === null && <p className="muted">読み込み中…</p>}
      {cfg !== null && (
        <div className="card">
          <p style={{ marginTop: 0 }}>ログインは「{portal.name}」でまとめて行います。1 つのアカウントで、権限のある学びをすべて開けます。</p>
          <a className="btn btn-primary btn-block" href={`${base}/sso/start?app=${encodeURIComponent(cfg.app)}`}>
            {portal.name}でログイン
          </a>
          <p className="muted small" style={{ marginTop: '0.8rem' }}>アカウントは管理者が作ります。パスワードを忘れたら管理者に再設定を頼んでください。</p>
        </div>
      )}
    </div>
  )
}
