import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  dayKey,
  formatDuration,
  formatLeft,
  formatTokens,
  formatUsd,
  limitLabel,
  runsOutIn,
  shortModel,
  spend,
} from '../hooks/register'

const NOON = Date.UTC(2026, 9, 7, 12)
const HOUR = 3_600_000
const DAY = 24 * HOUR

test('formats duration, tokens, cost, time left and names', () => {
  expect(formatDuration(0)).toBe('0:00')
  expect(formatDuration(65_000)).toBe('1:05')
  expect(formatDuration(3_725_000)).toBe('1:02:05')
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(12_345)).toBe('12.3k')
  expect(formatTokens(2_500_000)).toBe('2.5M')
  expect(formatUsd(0.1234)).toBe('$0.123')
  expect(formatUsd(12.5)).toBe('$12.50')
  expect(formatLeft(90 * 60_000)).toBe('1h 30m')
  expect(formatLeft(2 * DAY + 4 * HOUR)).toBe('2d 4h')
  expect(formatLeft(5 * 60_000)).toBe('5m')
  expect(limitLabel('five_hour')).toBe('5h')
  expect(limitLabel('seven_day')).toBe('7d')
  expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
  expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
})

test('sums today and the last seven days from the ledger', () => {
  const book = {
    [dayKey(NOON)]: 1,
    [dayKey(NOON - DAY)]: 2,
    [dayKey(NOON - 6 * DAY)]: 4,
    [dayKey(NOON - 7 * DAY)]: 100,
  }
  expect(spend(book, NOON)).toEqual({ today: 1, week: 7 })
})

test('projects when a window runs out, only before its reset', () => {
  const resetsAt = new Date(NOON + 4 * HOUR).toISOString()
  const burn = { resetsAt, percent: 20, at: NOON - HOUR }
  // 20% → 60% in an hour: 40% left takes another hour, before the reset.
  expect(runsOutIn(burn, { kind: 'five_hour', percentUsed: 60, resetsAt }, NOON)).toBe(HOUR)
  // 20% → 25% in an hour: 75% left takes 15h, after the reset.
  expect(runsOutIn(burn, { kind: 'five_hour', percentUsed: 25, resetsAt }, NOON)).toBe(null)
  // Too soon to tell.
  expect(runsOutIn({ ...burn, at: NOON - 60_000 }, { kind: 'five_hour', percentUsed: 60, resetsAt }, NOON)).toBe(null)
  // Another window (the reset moved).
  expect(runsOutIn(burn, { kind: 'five_hour', percentUsed: 60, resetsAt: 'x' }, NOON)).toBe(null)
})

const limitsAt = (fiveHour: number) => [
  { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOON + 4 * HOUR).toISOString() },
  { kind: 'seven_day', percentUsed: 91 },
]

function world(on: On, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOON })
  mock.store(on, store)
  const compacts: number[] = []
  const toasts: string[] = []
  on('session.start', () => ({ cwd: '/' }))
  on('session.usage', () =>
    ({ value: { startedAt: NOON - 65_000, context: { window: 200_000, percent: 12 }, rateLimits: limitsAt(20), cost: { usd: 0.5 } } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }) as never)
  on('ui.toast', (_, e) => (toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e))), { value: undefined }) as never)
  on('session.compact', () => (compacts.push(1), { skip: 'test' }) as never)
  on('ui.render', () => ({ type: 'Box', children: [] }) as never)
  on('command.run', () => ({ text: '' }))

  return { clock, compacts, toasts }
}

const measure = (usd: number, percent: number, fiveHour: number) =>
  ({ context: { window: 200_000, percent }, rateLimits: limitsAt(fiveHour), cost: { usd }, changed: ['cost', 'context', 'rateLimits'] }) as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws model, usage, spend and limits on ${surface}`, async ($, on) => {
    const { clock } = world(on, { ledger: { [dayKey(NOON - DAY)]: 3 } })
    await $.session.start({ cwd: '/' } as never)
    await $.turn.complete({
      answer: '',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
    } as never)
    await clock.advance(HOUR)
    await $.session.measure(measure(0.75, 40, 60))

    const ui = await $.ui.mount({ plugin: 'session-meter', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('opus-5-5')
    expect(drawn).toContain('1:01:05')
    expect(drawn).toContain('1.5k')
    expect(drawn).toContain('out 500')
    expect(drawn).toContain('context 40%')
    // The session spent 0.25 since it started: booked to today, yesterday's 3 in the week.
    expect(drawn).toContain('$0.750 · today $0.250 · 7d $3.250')
    expect(drawn).toContain('7d 91%')
    // 20% → 60% in an hour: out in an hour, before the 3h reset.
    expect(drawn).toContain('5h 60% ↻3h 0m ⚠ out in ~1h 0m')
    expect(drawn).toContain('"color":"error"')
  })
}

test('/meter hides and shows the band, and remembers it', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/' } as never)
  const props = { hasSurvey: false, isWorking: false } as never

  expect((await $.command.run({ command: 'meter', args: '' } as never)).text).toContain('hidden')
  const off = JSON.stringify(await (await $.ui.mount({ plugin: 'session-meter', surface: 'terminal', component: 'AbovePrompt', props })).drawn())
  expect(off).not.toContain('tokens')

  expect((await $.command.run({ command: 'meter', args: '' } as never)).text).toContain('shown')
  const onAgain = JSON.stringify(await (await $.ui.mount({ plugin: 'session-meter', surface: 'terminal', component: 'AbovePrompt', props })).drawn())
  expect(onAgain).toContain('tokens')
})

test('compacts at 85% context only with autocompact on, once per climb', async ($, on) => {
  const { compacts, toasts } = world(on)
  await $.session.start({ cwd: '/' } as never)

  await $.session.measure(measure(0.5, 86, 20))
  expect(compacts.length).toBe(0)
  expect(toasts.join()).toContain('consider /compact')

  expect((await $.command.run({ command: 'meter', args: 'autocompact on' } as never)).text).toContain('on')
  await $.session.measure(measure(0.5, 50, 20))
  await $.session.measure(measure(0.5, 87, 20))
  await $.session.measure(measure(0.5, 88, 20))
  expect(compacts.length).toBe(1)
})
