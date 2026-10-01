// @vitest-environment jsdom
/** 上部メニューとルート（src/client/App.tsx）。ロードマップ型と資格版で分かれる枝を見る。
 *
 *  対象は読み込み時に決まる（VITE_EXAM）ので、対象ごとに読み込み直して描く。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 資格版のホームに出るおすすめ（資格版の画面が出たことの目印）。 */
const NEXT_TOPIC_TERM = '頻出の未理解の論点'
/** ロードマップ型の単位（ロードマップの画面が出たことの目印）。 */
const UNIT_TERM = '1 日目の単位の名前'

const ME = {
  user: { id: 'u-1', name: '学ぶ人', role: 'MEMBER' },
  topics: { total: 7, understood: 1, partly: 0 },
  recentSessions: [],
  nextTopics: [{ id: 231, term: NEXT_TOPIC_TERM, questionCount: 8, field: 'ストラテジ系' }],
  visits: { today: '2026-09-29', streak: 1, longest: 1, total: 1 },
}

const UNITS = [
  {
    id: 101,
    term: UNIT_TERM,
    questionCount: 2,
    status: null,
    field: '業界と仕事',
    middle: 'コンサルの仕事',
    itemName: 'コンサルの仕事',
    isNew: 0,
    sortOrder: 1,
  },
]

function stubApi() {
  vi.stubGlobal('fetch', async (raw: string) => {
    const url = new URL(String(raw), 'http://localhost')
    const p = url.pathname
    let body: unknown = {}
    if (p.endsWith('/auth/config')) body = { sso: true, portal: 'https://portal.example', app: 'ip' }
    else if (p.endsWith('/me')) body = ME
    else if (p.endsWith('/topics')) body = { topics: UNITS }
    else if (p.endsWith('/fields')) body = { fields: [] }
    else if (p.endsWith('/categories')) body = { categories: [] }
    else if (p.endsWith('/exams')) body = { exams: [] }
    else if (p.endsWith('/sessions/current')) body = { session: null }
    else if (p.endsWith('/sessions')) body = { sessions: [] }
    else if (p.endsWith('/glossary')) body = { glossary: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  })
}

/** name を持つトークン（画面は中身だけを見る）。 */
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`
}

/** 対象を決めて App を描く。 */
async function drawApp(exam: string, entry: string) {
  vi.stubEnv('VITE_EXAM', exam)
  vi.resetModules()
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const api = await import('../../src/client/lib/api')
  api.setToken(jwtWith({ sub: 'u-1', name: '学ぶ人', role: 'MEMBER' }))
  const { App } = await import('../../src/client/App')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        React.createElement(App),
      ),
    )
  })
  const menu = host.querySelector('nav') ?? host.querySelector('header') ?? host
  return {
    text: () => host.textContent ?? '',
    menuText: () => menu.textContent ?? '',
    menuHrefs: () =>
      [...menu.querySelectorAll('a')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.startsWith('/') && h !== '/'),
    close: async () => {
      await React.act(async () => root.unmount())
      host.remove()
    },
  }
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('上部メニュー', () => {
  // @covers REQ-128#roadmap-type-destinations
  it('ロードマップ型はロードマップとフィードバックの 2 つだけで、資格の語を出さない', async () => {
    // ロードマップ型ではロードマップが /topics に載っている
    const v = await drawApp('itc', '/topics')
    const hrefs = new Set(v.menuHrefs())
    expect([...hrefs].sort()).toEqual(['/feedback', '/topics'])
    expect(v.menuText()).toContain('ロードマップ')
    expect(v.menuText()).toContain('フィードバック')
    for (const word of ['練習', '模試', '履歴']) {
      expect(v.menuText(), `メニューに資格の語「${word}」が出ている`).not.toContain(word)
    }
    await v.close()
  })

  // @covers REQ-128#cert-type-not-restricted
  it('資格版のメニューは資格の画面を持ったままにする', async () => {
    const v = await drawApp('ip', '/')
    const hrefs = new Set(v.menuHrefs())
    for (const to of ['/topics', '/practice', '/exams', '/history']) {
      expect([...hrefs], `資格版のメニューに ${to} が無い`).toContain(to)
    }
    await v.close()
  })
})

describe('無くした画面の経路', () => {
  // @covers REQ-128#cert-only-location
  it('ロードマップ型ではホーム・練習テスト・確認テスト・履歴がロードマップ（/topics）へ送られる', async () => {
    for (const entry of ['/', '/practice', '/exams', '/history']) {
      const v = await drawApp('itc', entry)
      expect(v.text(), `${entry} がロードマップになっていない`).toContain(UNIT_TERM)
      await v.close()
    }
  })

  // @covers REQ-128#cert-type-not-restricted
  it('資格版では各画面がそのまま出る（ロードマップに置き換わらない）', async () => {
    const home = await drawApp('ip', '/')
    expect(home.text()).toContain(NEXT_TOPIC_TERM)
    await home.close()
    const history = await drawApp('ip', '/history')
    expect(history.text(), '資格版の履歴がロードマップに置き換わっている').not.toContain(UNIT_TERM)
    await history.close()
  })
})
