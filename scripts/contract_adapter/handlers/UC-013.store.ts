/**
 * UC-013 の端末の記憶の受け持ち（saveToken・readToken・clearToken・markSessionExpired・takeSessionExpired）。
 * `http` の操作は handlers/UC-013.ts が持つ。
 * 入口は `src/client/lib/` の export（save… は set…、read… は get…）。markSessionExpired は規則に従わない入口の `api`
 * （トークンを持った呼び出しが 401 を受けると印を残す）。実例ごとに端末の記憶の代わりを新しく置く（kit/tc.ts）。
 * 応答は契約どおり「書いた・捨てた・残したあとに読む」値（getToken・takeSessionExpired）。
 * 前提:
 * - saveToken.storageUnavailable: 端末の記憶に書けない。
 * - readToken.ok: saveToken の実例のトークンを持つ端末。none: トークンの無い端末。unreadable: 端末の記憶が読めない。
 * - clearToken.ok: トークンを持つ端末。
 * - markSessionExpired.ok: トークンを持つ端末で、学び側が 401 を返す偽の相手に `api` で呼ぶ。
 * - takeSessionExpired.ok: 上と同じ手順で印が残った端末。none: 印の無い端末。
 */

import { withFetch } from '../kit/outside'
import { answerFrom, deviceWorld, type DeviceWorld } from '../kit/tc'
import { defineHandler, type ExampleLine } from '../kit/protocol'

/** 契約 saveToken の実例のトークン。 */
const TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ZDJiOGExMCIsIm5hbWUiOiJ0YXJvIiwicm9sZSI6Ik1FTUJFUiIsImV4cCI6MTc5OTk5OTk5OX0.c2lnbmF0dXJlLXNhbXBsZQ'

/** トークンを持った呼び出しが期限切れ（401）で断られる（REQ-197 の前提）。 */
async function expireSession(w: DeviceWorld): Promise<void> {
  w.api.setToken(TOKEN)
  const unauthorized = async () =>
    new Response(JSON.stringify({ error: '認証が必要です' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  await withFetch(unauthorized, () => w.api.api('/me').catch(() => undefined))
}

const requested = <T>(line: ExampleLine) => line.request as T

/**
 * @implements REQ-567, REQ-570
 */
export default defineHandler({
  uc: 'UC-013',
  operations: {
    saveToken: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'storageUnavailable') w.blockWrites()
      return answerFrom(() => {
        w.api.setToken(requested<{ token: string }>(line).token)
        return { token: w.api.getToken() }
      })
    },
    readToken: async (line) => {
      const w = await deviceWorld()
      if (line.case !== 'none') w.api.setToken(TOKEN)
      if (line.case === 'unreadable') w.blockReads()
      return answerFrom(() => ({ token: w.api.getToken() }))
    },
    clearToken: async () => {
      const w = await deviceWorld()
      w.api.setToken(TOKEN)
      return answerFrom(() => {
        w.api.clearToken()
        return { token: w.api.getToken() }
      })
    },
    markSessionExpired: async () => {
      const w = await deviceWorld()
      return answerFrom(async () => {
        await expireSession(w)
        return { expired: w.api.takeSessionExpired() }
      })
    },
    takeSessionExpired: async (line) => {
      const w = await deviceWorld()
      if (line.case === 'ok') await expireSession(w)
      return answerFrom(() => ({ expired: w.api.takeSessionExpired() }))
    },
  },
})
