import { expect, it } from 'vitest'
import { SpeedController, parseServed } from '../src/host/speed.js'

const headers = (extra: Record<string, string> = {}) => new Headers({
  'anthropic-ratelimit-unified-5h-reset': '1794679200', 'anthropic-ratelimit-unified-5h-utilization': '0.44',
  'anthropic-ratelimit-unified-7d-reset': '1795057200', 'x-magpie-provider': 'claude', ...extra,
})

it('parseServed 只取重置时间、用量和上游名', () => {
  expect(parseServed(headers())).toEqual({ provider: 'claude', fiveHour: { reset: 1794679200, used: 0.44 }, weekly: { reset: 1795057200 } })
  expect(parseServed(new Headers({ 'x-magpie-provider': 'claude' }))).toBeUndefined()
  expect(parseServed(new Headers({ 'anthropic-ratelimit-unified-5h-reset': 'x' }))).toBeUndefined()
})
it('SpeedController 按会话保存最近一次，并随 speed 读取返回；无头时不返回 served', () => {
  const speed = new SpeedController()
  const sid = '11111111-1111-4111-8111-111111111111'
  expect(speed.get(sid)).not.toHaveProperty('served')
  speed.recordServed(sid, new Headers())
  expect(speed.get(sid)).not.toHaveProperty('served')
  speed.recordServed(sid, headers())
  expect(speed.get(sid)).toMatchObject({ served: { provider: 'claude', fiveHour: { reset: 1794679200 } } })
})
