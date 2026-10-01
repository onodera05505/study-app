// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// api.ts はモジュールの中で memo を持つので、テストごとに読み直す
async function load() {
  vi.resetModules()
  return await import('../../src/client/lib/api')
}

function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 端末に入っている値の一覧。鍵の名前に頼らずに「保存されたか」だけを見る。 */
function storedValues(s: Storage): string[] {
  return Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i)!) ?? '')
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('トークンの保存（UC-013）', () => {
  // @covers REQ-191#token-survives-reload
  it('setToken で端末（localStorage）にトークンが残る', async () => {
    const m = await load()
    m.setToken('tok-1')
    expect(storedValues(localStorage)).toContain('tok-1')
    // 読み直しても残る（モジュールの中の変数ではなく端末に置いてある）
    const reloaded = await load()
    expect(reloaded.getToken()).toBe('tok-1')
  })

  // @covers REQ-191#token-round-trip
  it('getToken は保存前は null、保存後は同じ値', async () => {
    const m = await load()
    expect(m.getToken()).toBeNull()
    m.setToken('tok-2')
    expect(m.getToken()).toBe('tok-2')
  })

  // @covers REQ-196#request-carries-token
  it('api() はトークンがあれば Authorization: Bearer を付け、無ければ付けない', async () => {
    const m = await load()
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push([String(url), init]); return okJson({ ok: true }) }))
    await m.api('/anything')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/api/anything')
    expect((calls[0][1]?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined()
    m.setToken('tok-1')
    await m.api('/anything')
    expect(calls).toHaveLength(2)
    expect((calls[1][1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  // @covers REQ-198#token-and-device-memory-cleared
  it('clearToken はトークンと「前回の続き」を両方消す', async () => {
    const m = await load()
    m.setToken('tok-1')
    m.setLastTopic({ id: 3, term: 'x', middle: 'y', middleNo: 1 })
    expect(storedValues(localStorage)).toContain('tok-1')
    m.clearToken()
    expect(m.getToken()).toBeNull()
    expect(m.getLastTopic()).toBeNull()
    expect(storedValues(localStorage)).not.toContain('tok-1')
  })
})

describe('API 呼び出しの失敗の形', () => {
  // @verifies REQ-097
  it('投げられる失敗は 1 つの型で、message・status・body を読める', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '入力が正しくありません', detail: 'x' }, 400)))
    const err = await m.api('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(m.ApiError)
    expect(err).toBeInstanceOf(Error)
    const e = err as InstanceType<typeof m.ApiError>
    expect(typeof e.message).toBe('string')
    expect(e.status).toBe(400)
    expect(e.body).toEqual({ error: '入力が正しくありません', detail: 'x' })
  })

  // @verifies REQ-051
  it('失敗の本文 {error} を message にする（{error} が無ければ既定の日本語の文）', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '入力が正しくありません' }, 400)))
    const e = (await m.api('/x').catch((x: unknown) => x)) as InstanceType<typeof m.ApiError>
    expect(e.message).toBe('入力が正しくありません')
    expect(e.status).toBe(400)
    expect(e.body).toEqual({ error: '入力が正しくありません' })

    // {error} を持たない失敗（画面に出せる日本語の 1 文に倒す。英語の既定文を出さない）
    vi.stubGlobal('fetch', vi.fn(async () => okJson({}, 500)))
    const e2 = (await m.api('/y').catch((x: unknown) => x)) as InstanceType<typeof m.ApiError>
    expect(e2.status).toBe(500)
    expect(e2.message).toMatch(/[ぁ-んァ-ヶ一-龥]/)
  })

  // @verifies REQ-098
  it('通信できないときは status 無しの日本語の固定文', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const e = (await m.api('/x').catch((x: unknown) => x)) as InstanceType<typeof m.ApiError>
    expect(e).toBeInstanceOf(m.ApiError)
    expect(e.status).toBeUndefined()
    expect(e.message).toMatch(/[ぁ-んァ-ヶ一-龥]/)
    expect(e.message).toContain('通信')
    expect(e.message).not.toContain('Failed to fetch')
  })

  // @covers REQ-197#expired-token-401
  it('トークン付きで 401 なら期限切れの印を立ててトークンを捨てる', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '認証が必要です' }, 401)))
    m.setToken('old')
    await m.api('/x').catch(() => {})
    expect(m.getToken()).toBeNull()
    expect(m.takeSessionExpired()).toBe(true)
  })

  // @covers REQ-194#no-expiry-notice
  it('トークン無しの 401 では期限切れの印を立てない（元から未ログイン）', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '認証が必要です' }, 401)))
    await m.api('/x').catch(() => {})
    expect(m.takeSessionExpired()).toBe(false)
  })
})

describe('期限切れの印（UC-013）', () => {
  // @covers REQ-197#notice-once
  it('印は 1 度だけ取り出せる。印が無ければ false', async () => {
    const m = await load()
    expect(m.takeSessionExpired()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '認証が必要です' }, 401)))
    m.setToken('old')
    await m.api('/x').catch(() => {})
    expect(m.takeSessionExpired()).toBe(true)
    expect(m.takeSessionExpired()).toBe(false)
  })
})

describe('ヘッダーの本人の名前（UC-013）', () => {
  // @covers REQ-199#name-from-token
  it('トークンの中身の name を返し、サーバに聞かない', async () => {
    const m = await load()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    m.setToken(jwtWith({ sub: 'u1', name: '小野寺' }))
    expect(m.getUserName()).toBe('小野寺')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // @covers REQ-199#name-unknown
  it('トークンが無い・壊れている・name が無いときは null', async () => {
    const m = await load()
    expect(m.getUserName()).toBeNull()
    m.setToken('not.a.jwt')
    expect(m.getUserName()).toBeNull()
    m.setToken(jwtWith({ sub: 'u1' }))
    expect(m.getUserName()).toBeNull()
  })
})

describe('分野・カテゴリの集計の記憶', () => {
  // @verifies REQ-054, REQ-129
  it('同じ path は 1 回だけ取りに行き、invalidateCached の後は取り直す', async () => {
    const m = await load()
    const fetchMock = vi.fn(async () => okJson([{ field: 'x' }]))
    vi.stubGlobal('fetch', fetchMock)
    await m.apiCached('/fields')
    await m.apiCached('/fields')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    m.invalidateCached()
    await m.apiCached('/fields')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // @verifies REQ-054
  it('失敗した取得は覚えず、次の呼び出しで取り直す', async () => {
    const m = await load()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? okJson({ error: 'だめ' }, 500) : okJson([]))))
    await m.apiCached('/fields').catch(() => {})
    await expect(m.apiCached('/fields')).resolves.toEqual([])
    expect(n).toBe(2)
  })
})
