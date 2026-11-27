// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { BackLink } from '../../src/client/components/BackLink'

/** 戻る導線（BR-016: 行き先を明示し、ブラウザの履歴に頼らない）。ロードマップ型ではロードマップが /topics に載る。 */
describe('戻る導線（UC-009）', () => {
  // @covers REQ-141#back-to-roadmap
  it('論点の画面の戻る導線は行き先（ロードマップ）とラベルを明示したリンクで、選ぶと履歴に依らずロードマップが出る', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        // 履歴に戻り先を積まずに論点の画面から始める（履歴に頼っていれば戻れない）
        <MemoryRouter initialEntries={['/topics/101']}>
          <Routes>
            <Route path="/topics" element={<div>ROADMAP-MARKER</div>} />
            <Route path="/topics/:id" element={<BackLink to="/topics" label="ロードマップに戻る" />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    const a = [...host.querySelectorAll('a')].find((x) => x.textContent === 'ロードマップに戻る')
    expect(a, 'ラベルを明示した戻る導線が無い').toBeDefined()
    expect(a!.getAttribute('href')).toBe('/topics')
    expect(a!.querySelector('svg')?.getAttribute('aria-hidden'), 'アイコンが読み上げ対象になっている').toBe('true')
    await act(async () => {
      a!.click()
    })
    expect(host.textContent).toContain('ROADMAP-MARKER')
    await act(async () => root.unmount())
    host.remove()
  })
})
