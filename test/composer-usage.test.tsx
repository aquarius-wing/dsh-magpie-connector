// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ComposerUsage, cardsForOwner, ownerOfSelection, summarize, tooltipText, formatCountdown } from '../src/client/ComposerUsage.js'
import { sidebarRows } from '../src/client/sidebar-view.js'
import { SIDEBAR_WINDOW_KINDS } from '../src/shared/sidebar-window.js'
import { resetSidebarCardsCache } from '../src/client/sidebar-api.js'
import { fakeApi, flush, ok } from './client-support/fake-api.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => { resetSidebarCardsCache(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const CARDS = [
  { provider: 'claude', name: 'Claude', windows: [{ name: '5 hours', used: 12, resetsAt: '2030-01-02T03:04:00Z' }, { name: '7 days', used: 40 }] },
  { provider: 'codex', name: 'Codex', windows: [{ name: '7 days', used: 80 }] },
]
async function mount(selection: { provider: string; model: string } | null, cards: ReturnType<typeof fakeApi>) {
  await act(async () => root.render(h(ComposerUsage, { api: cards.api, loadSelection: async () => selection })))
  await flush()
}
const line = () => host.querySelector('[data-magpie-composer-usage]')

describe('输入框下方用量行', () => {
  it('ownerOfSelection 只认本插件的 owner 路由', () => {
    expect(ownerOfSelection({ provider: 'dsh-magpie-connector-claude', model: 'x' })).toBe('claude')
    expect(ownerOfSelection({ provider: 'deepseek', model: 'x' })).toBeUndefined()
    expect(ownerOfSelection(null)).toBeUndefined()
  })
  it('cardsForOwner 按 owner 匹配，没有匹配时退回全部卡片', () => {
    expect(cardsForOwner(CARDS as never, 'Claude')).toMatchObject({ matched: true, cards: [{ provider: 'claude' }] })
    expect(cardsForOwner(CARDS as never, 'other')).toMatchObject({ matched: false, cards: CARDS })
  })
  it('选中 Magpie 模型时只显示该上游的各窗口用量', async () => {
    const fake = fakeApi({ 'GET cards': () => ok({ status: 'ok', cards: CARDS }) })
    await mount({ provider: 'dsh-magpie-connector-claude', model: 'claude/opus' }, fake)
    const text = line()!.textContent!
    expect(text).toContain('5h limit 12%'); expect(text).toContain('7d limit 40%')
    expect(text).not.toContain('Codex')
  })
  it('选中非 Magpie 模型时不渲染，也不请求用量', async () => {
    const fake = fakeApi({ 'GET cards': () => ok({ status: 'ok', cards: CARDS }) })
    await mount({ provider: 'deepseek', model: 'deepseek-flash' }, fake)
    expect(line()).toBeNull(); expect(fake.calls).toHaveLength(0)
  })
  it('网关返回 403 时显示可读的提示而不是空白', async () => {
    const fake = fakeApi({ 'GET cards': () => ({ status: 403, body: { status: 'forbidden' } }) })
    await mount({ provider: 'dsh-magpie-connector-claude', model: 'claude/opus' }, fake)
    expect(line()!.textContent).toContain('无权读取额度')
  })
  it('首次请求抛错时显示不可用提示，不留空白', async () => {
    const api = (async () => { throw new Error('network down') }) as never
    await act(async () => root.render(h(ComposerUsage, { api, loadSelection: async () => ({ provider: 'dsh-magpie-connector-claude', model: 'm' }) })))
    await flush()
    expect(line()!.textContent).toContain('暂不可用')
  })
  it('切换上游后读取失败，不显示上一个上游的数据', async () => {
    let current = { provider: 'dsh-magpie-connector-claude', model: 'm' }
    let fail = false
    const api = (async () => { if (fail) throw new Error('x'); return ok({ status: 'ok', cards: CARDS }) }) as never
    let notify = () => {}
    const props = { api, loadSelection: async () => current, watchModel: (cb: () => void) => { notify = cb; return () => {} } }
    await act(async () => root.render(h(ComposerUsage, props)))
    await flush()
    expect(line()!.textContent).toContain('5h limit')
    fail = true; resetSidebarCardsCache(); current = { provider: 'dsh-magpie-connector-codex', model: 'm' }
    await act(async () => { notify() })
    await flush()
    expect(line()!.textContent).not.toContain('5h limit')
    expect(line()!.textContent).toContain('暂不可用')
  })
  it('多账号：用量取平均，重置取最早；单账号直接显示自己的重置', () => {
    const two = [
      { provider: 'claude', name: 'A', windows: [{ name: '5 hours', used: 20, resetsAt: '2030-01-02T10:00:00Z' }, { name: '7 days', used: 10 }] },
      { provider: 'claude', name: 'B', user: 'b', windows: [{ name: '5 hours', used: 60, resetsAt: '2030-01-02T08:00:00Z' }] },
    ]
    const rings = summarize(sidebarRows(two as never, SIDEBAR_WINDOW_KINDS))
    expect(rings).toEqual([
      { kind: 'fiveHour', used: 40, resetsAt: '2030-01-02T08:00:00.000Z', accounts: 2 },
      { kind: 'weekly', used: 10, accounts: 1 },
    ])
    expect(tooltipText(rings[0]!, Date.parse('2030-01-01T00:00:00Z'))).toContain('2 个账号平均已用 40%')
    expect(tooltipText(rings[1]!, 0)).toBe('7d limit 已用 10%')
  })
  it('悬浮显示 tooltip，点击打开账号面板，Esc 关闭', async () => {
    const fake = fakeApi({ 'GET cards': () => ok({ status: 'ok', cards: CARDS }) })
    await mount({ provider: 'dsh-magpie-connector-claude', model: 'claude/opus' }, fake)
    const trigger = host.querySelector('.dmg-cu-trigger') as HTMLButtonElement
    await act(async () => { trigger.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.querySelector('[role=tooltip]')?.textContent).toContain('5h limit 已用 12%')
    await act(async () => { trigger.click() })
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Claude')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('倒计时：天时 / 时分 / 分秒，静态文本', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    expect(formatCountdown('2030-01-03T03:30:00Z', now)).toBe('2 天 3 小时')
    expect(formatCountdown('2030-01-01T03:15:40Z', now)).toBe('3 小时 15 分')
    expect(formatCountdown('2030-01-01T00:15:30Z', now)).toBe('15 分 30 秒')
    expect(formatCountdown('2029-12-31T00:00:00Z', now)).toBe('0 分 0 秒')
    expect(formatCountdown('bad', now)).toBeUndefined()
    const ring = { kind: 'fiveHour' as const, used: 40, resetsAt: '2030-01-01T02:05:00Z', accounts: 2 }
    expect(tooltipText(ring, now)).toBe('5h limit 2 个账号平均已用 40%，最早还有 2 小时 5 分 重置')
  })
})
