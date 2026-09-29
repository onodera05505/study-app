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

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('トークンの保存', () => {
  // @verifies REQ-050
  it('保存したトークンは api() の Authorization: Bearer に付く', async () => {
    const m = await load()
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push([url, init]); return okJson({ ok: true }) }))
    m.setToken('tok-1')
    expect(m.getToken()).toBe('tok-1')
    await m.api('/anything')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/api/anything')
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  // @verifies REQ-050
  it('clearToken はトークンと「前回の続き」を両方消す', async () => {
    const m = await load()
    m.setToken('tok-1')
    m.setLastTopic({ id: 3, term: 'x', middle: 'y', middleNo: 1 })
    m.clearToken()
    expect(m.getToken()).toBeNull()
    expect(m.getLastTopic()).toBeNull()
  })
})

describe('API 呼び出しの失敗の形', () => {
  // @verifies REQ-051
  it('失敗の本文 {error} を message にした ApiError を投げる（status と body つき）', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '入力が正しくありません' }, 400)))
    const err = await m.api('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(m.ApiError)
    const e = err as InstanceType<typeof m.ApiError>
    expect(e.message).toBe('入力が正しくありません')
    expect(e.status).toBe(400)
    expect(e.body).toEqual({ error: '入力が正しくありません' })
  })

  // @verifies REQ-051
  it('通信できないときは status 無しの日本語の固定文', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const e = (await m.api('/x').catch((x: unknown) => x)) as InstanceType<typeof m.ApiError>
    expect(e).toBeInstanceOf(m.ApiError)
    expect(e.status).toBeUndefined()
    expect(e.message).toContain('通信できませんでした')
  })

  // @verifies REQ-051, REQ-052
  it('トークン付きで 401 なら期限切れの印を立ててトークンを捨てる。印は 1 度読むと消える', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '認証が必要です' }, 401)))
    m.setToken('old')
    await m.api('/x').catch(() => {})
    expect(m.getToken()).toBeNull()
    expect(m.takeSessionExpired()).toBe(true)
    expect(m.takeSessionExpired()).toBe(false)
  })

  // @verifies REQ-051, REQ-052
  it('トークン無しの 401 では期限切れの印を立てない（元から未ログイン）', async () => {
    const m = await load()
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: '認証が必要です' }, 401)))
    await m.api('/x').catch(() => {})
    expect(m.takeSessionExpired()).toBe(false)
  })
})

describe('ヘッダーの本人の名前', () => {
  // @verifies REQ-053
  it('トークンの中身の name を返し、サーバに聞かない', async () => {
    const m = await load()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    m.setToken(jwtWith({ sub: 'u1', name: '小野寺' }))
    expect(m.getUserName()).toBe('小野寺')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // @verifies REQ-053
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
  // @verifies REQ-054
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
