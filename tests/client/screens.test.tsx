// @vitest-environment jsdom
/** 画面を実際に描いて、出典・一部改変（結果画面）と SSO のログイン画面を見る。
 *
 *  純粋な関数に切り出せない振る舞い（サーバの応答をそのまま出す所）なので、
 *  fetch を偽物にして本物の React で描く。 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Login } from '../../src/client/pages/Login'
import { Result } from '../../src/client/pages/Result'

let container: HTMLElement
let root: Root

const text = () => container.textContent ?? ''

/** path ごとに返す JSON を決める偽の fetch。 */
function stubApi(bodyOf: (url: string) => unknown) {
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(bodyOf(String(url))),
  }))
}

async function draw(node: ReactNode, entry = '/') {
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [entry] }, node))
  })
}

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.render(null)
  })
  vi.unstubAllGlobals()
})

/** 結果画面が受け取る応答。1 問だけ、間違えた問題（既定の「間違えた問題だけ」に出る）。 */
const RESULT = {
  session: { kind: 'mock', scopeLabel: '令和6年度', questionCount: 1, sourceExam: '2024r06' },
  overall: { total: 1, correct: 0, pct: 0 },
  fields: [{ field: 'ストラテジ系', total: 1, correct: 0, pct: 0 }],
  passed: false,
  expired: false,
  criteria: { overallPct: 60, fieldPct: 30 },
  approximation: '本番は IRT のため公式スコアとは一致しません。',
  items: [
    {
      idx: 0,
      text: '次のうち正しいものはどれか。',
      choices: { ア: '正しい', イ: '誤り' },
      answer: 'ア',
      userAnswer: 'イ',
      result: 2,
      citation: '出典：令和6年度 ITパスポート試験 問8',
      modified: true,
      hasFigure: false,
      figureDescription: null,
      figureImage: null,
      timesAsked: 1,
      otherCitations: [],
      topicId: null,
      topicTerm: null,
      explanation: null,
    },
  ],
}

describe('結果画面の出典', () => {
  // @verifies REQ-027
  it('問題ごとに「出典：<年度ラベル> <試験名> 問N」が出る', async () => {
    stubApi(() => RESULT)
    await draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
    expect(text()).toContain('出典：令和6年度 ITパスポート試験 問8')
    // 年度ラベルが内部コード（2024r06）のまま出ていない
    expect(text()).not.toContain('2024r06')
  })

  // @verifies REQ-028
  it('原文を書き換えた問題には「一部改変」が併記される', async () => {
    stubApi(() => RESULT)
    await draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
    const note = container.querySelector('.citation .modified-note')
    expect(note?.textContent).toBe('（一部改変）')
  })

  // @verifies REQ-028
  it('書き換えていない問題には「一部改変」を出さない', async () => {
    stubApi(() => ({ ...RESULT, items: [{ ...RESULT.items[0], modified: false }] }))
    await draw(
      h(Routes, null, h(Route, { path: '/sessions/:id/result', element: h(Result) })),
      '/sessions/s1/result',
    )
    expect(container.querySelector('.modified-note')).toBeNull()
    expect(text()).toContain('出典：令和6年度 ITパスポート試験 問8')
  })
})

describe('ログイン画面', () => {
  // @verifies REQ-006
  it('SSO の環境ではパスワード欄を出さず、まなびばへ送る', async () => {
    stubApi(() => ({ sso: true, portal: 'https://manabiba.example', app: 'ip' }))
    await draw(h(Login, { onDone: () => {} }))
    expect(container.querySelector('input[type="password"]')).toBeNull()
    const link = container.querySelector<HTMLAnchorElement>('a.btn')
    expect(link?.getAttribute('href')).toBe('https://manabiba.example/sso/start?app=ip')
  })

  // @verifies REQ-006
  it('SSO でない環境（ローカルの検査用）ではパスワードのフォームを出す', async () => {
    stubApi(() => ({ sso: false, portal: null, app: 'ip' }))
    await draw(h(Login, { onDone: () => {} }))
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })
})
