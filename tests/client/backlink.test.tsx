// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { BackLink } from '../../src/client/components/BackLink'

describe('戻るリンク', () => {
  // @verifies REQ-055
  it('行き先とラベルを明示したリンクを描き、アイコンは読み上げ対象にしない', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <BackLink to="/history" label="履歴に戻る" />
        </MemoryRouter>,
      )
    })
    const a = host.querySelector('a.back') as HTMLAnchorElement | null
    expect(a).not.toBeNull()
    expect(a!.getAttribute('href')).toBe('/history')
    expect(a!.textContent).toBe('履歴に戻る')
    expect(a!.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    await act(async () => root.unmount())
    host.remove()
  })
})
