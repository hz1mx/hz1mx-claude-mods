import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Burn, Ledger, Limit, Tokens } from '../types'

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const WARN_AT = [80, 95]
const CONTEXT_WARN = 85
const BURN_MIN_MS = 10 * 60_000
const LEDGER_DAYS = 31

const startedAt = atom({ plugin: 'session-meter', key: 'startedAt' } as const, null)
const now = atom({ plugin: 'session-meter', key: 'now' } as const, 0)
const model = atom({ plugin: 'session-meter', key: 'model' } as const, null)
const tokens = atom({ plugin: 'session-meter', key: 'tokens' } as const, ZERO)
const usd = atom({ plugin: 'session-meter', key: 'usd' } as const, null)
const lastUsd = atom({ plugin: 'session-meter', key: 'lastUsd' } as const, null)
const ledger = atom({ plugin: 'session-meter', key: 'ledger' } as const, {})
const contextPercent = atom({ plugin: 'session-meter', key: 'contextPercent' } as const, null)
const contextWarned = atom({ plugin: 'session-meter', key: 'contextWarned' } as const, false)
const limits = atom({ plugin: 'session-meter', key: 'limits' } as const, [])
const burns = atom({ plugin: 'session-meter', key: 'burns' } as const, {})
const warned = atom({ plugin: 'session-meter', key: 'warned' } as const, {})
const hidden = atom({ plugin: 'session-meter', key: 'hidden' } as const, false)
const autoCompact = atom({ plugin: 'session-meter', key: 'autoCompact' } as const, false)

const pad = (n: number) => String(n).padStart(2, '0')

export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)

  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

export const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`

  return String(n)
}

export const formatUsd = (v: number) => `$${v < 10 ? v.toFixed(3) : v.toFixed(2)}`

/** Time left, coarse: `2d 4h`, `3h 10m`, `12m`. */
export const formatLeft = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)

  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`

  return `${m}m`
}

export const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind.replace(/_/g, ' ')

/** `claude-opus-5-5` → `opus-5-5`; a `[1m]` suffix stays. */
export const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

/** The local day, `YYYY-MM-DD`. */
export const dayKey = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today's spend and the last seven days' (today included). */
export const spend = (book: Ledger, at: number) => {
  let week = 0
  for (let i = 0; i < 7; i++) week += book[dayKey(at - i * 86_400_000)] ?? 0

  return { today: book[dayKey(at)] ?? 0, week }
}

/**
 * When the window runs out at the pace since its first reading, in ms from
 * `at`; null while too early to tell, not burning, or the reset comes first.
 */
export const runsOutIn = (burn: Burn | undefined, l: Limit, at: number) => {
  if (!burn || !l.resetsAt || burn.resetsAt !== l.resetsAt) return null
  const elapsed = at - burn.at
  const used = l.percentUsed - burn.percent
  if (elapsed < BURN_MIN_MS || used <= 0) return null
  const left = ((100 - l.percentUsed) / used) * elapsed
  const reset = Date.parse(l.resetsAt)

  return Number.isNaN(reset) || at + left < reset ? left : null
}

const severity = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined)

async function setLimits($: EngineInterface, next: Limit[]) {
  const at = await $.clock.now()
  await update($, limits, () => next.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })))

  // A window's first reading is where its burn is measured from; a new reset time starts it over.
  await update($, burns, prev => {
    const out: Record<string, Burn> = { ...prev }
    for (const l of next) {
      if (l.resetsAt && out[l.kind]?.resetsAt !== l.resetsAt) {
        out[l.kind] = { resetsAt: l.resetsAt, percent: l.percentUsed, at }
      }
    }

    return out
  })

  // One toast per threshold per window; a reset (percent falls back) re-arms it.
  const seen = await read($, warned)
  const after: Record<string, number> = { ...seen }
  for (const l of next) {
    const prior = l.percentUsed < (seen[l.kind] ?? 0) ? 0 : (seen[l.kind] ?? 0)
    const crossed = WARN_AT.filter(p => l.percentUsed >= p).pop() ?? 0
    if (crossed > prior) {
      $.ui.toast(`Limit ${limitLabel(l.kind)}: ${l.percentUsed}% used`)
    }
    after[l.kind] = Math.max(prior, crossed)
  }
  await update($, warned, () => after)
}

/** Adds what the session spent since the last reading to today's line in the shared ledger. */
async function addSpend($: EngineInterface, total: number) {
  const last = await read($, lastUsd)
  await update($, lastUsd, () => total)
  // No baseline yet, or the total fell (a /clear): nothing new to book.
  if (last === null || total <= last) return

  const at = await $.clock.now()
  const stored = ((await $.store.get('ledger')) ?? {}) as Ledger
  const today = dayKey(at)
  const oldest = dayKey(at - LEDGER_DAYS * 86_400_000)
  const book: Ledger = {}
  for (const [day, v] of Object.entries(stored)) if (day >= oldest) book[day] = v
  book[today] = (book[today] ?? 0) + (total - last)
  await $.store.set('ledger', book)
  await update($, ledger, () => book)
}

async function checkContext($: EngineInterface, percent: number) {
  const isWarned = await read($, contextWarned)
  if (percent < CONTEXT_WARN) {
    if (isWarned) await update($, contextWarned, () => false)

    return
  }
  if (isWarned) return
  await update($, contextWarned, () => true)

  if (await read($, autoCompact)) {
    $.ui.toast(`Context ${Math.round(percent)}%: compacting`)
    $.session.compact().catch(() => $.ui.toast('Auto-compact failed; run /compact'))
  } else {
    $.ui.toast(`Context ${Math.round(percent)}%: consider /compact`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Session meter: toggle the band, or `autocompact on|off`',
      argumentHint: '[autocompact on|off]',
    })

    const usage = await $.session.usage()
    const t0 = await $.clock.now()
    await update($, startedAt, () => usage.startedAt)
    await update($, now, () => t0)
    await update($, model, () => null)
    await update($, usd, () => usage.cost?.usd ?? null)
    // Kept across a reload, so what was booked is not booked twice.
    await update($, lastUsd, prev => prev ?? usage.cost?.usd ?? 0)
    await update($, contextPercent, () => usage.context.percent ?? null)
    const book = ((await $.store.get('ledger')) ?? {}) as Ledger
    const isHidden = (await $.store.get('hidden')) === true
    const isAuto = (await $.store.get('autoCompact')) === true
    await update($, ledger, () => book)
    await update($, hidden, () => isHidden)
    await update($, autoCompact, () => isAuto)
    await setLimits($, usage.rateLimits)
    const m = await $.session.model()
    await update($, model, () => m)

    $.clock.every(1000, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
    })

    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const [word, value] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'autocompact') {
      const isOn = value === 'on' ? true : value === 'off' ? false : !(await read($, autoCompact))
      await update($, autoCompact, () => isOn)
      await $.store.set('autoCompact', isOn)

      return { text: `Auto-compact at ${CONTEXT_WARN}% context: ${isOn ? 'on' : 'off'}` }
    }

    const isHidden = !(await read($, hidden))
    await update($, hidden, () => isHidden)
    await $.store.set('hidden', isHidden)

    return { text: isHidden ? 'Session meter hidden (/meter to show)' : 'Session meter shown' }
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      await update($, tokens, t => ({
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
      }))
    }
    if (!e.agentId) {
      const m = await $.session.model()
      await update($, model, () => m)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost) {
      const total = e.cost.usd
      await update($, usd, () => total)
      await addSpend($, total)
    }
    const percent = e.context.percent
    if (percent !== undefined) {
      await update($, contextPercent, () => percent)
      await checkContext($, percent)
    }
    if (e.changed.includes('rateLimits')) {
      await setLimits($, e.rateLimits)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const since = await read($, startedAt)
    if (e.props.hasSurvey || since === null || (await read($, hidden))) {
      return next(e)
    }

    const at = await read($, now)
    const m = await read($, model)
    const t = await read($, tokens)
    const cost = await read($, usd)
    const ctx = await read($, contextPercent)
    const windows = await read($, limits)
    const started = await read($, burns)
    const { today, week } = spend(await read($, ledger), at)
    const total = t.input + t.output + t.cacheRead + t.cacheWrite

    type Part = { text: string; color?: 'warning' | 'error' }
    const top: Part[] = []
    if (m) top.push({ text: shortModel(m) })
    top.push({ text: `⏱ ${formatDuration(at - since)}` })
    top.push({ text: `tokens ${formatTokens(total)} (in ${formatTokens(t.input + t.cacheRead + t.cacheWrite)} / out ${formatTokens(t.output)})` })
    if (ctx !== null) top.push({ text: `context ${Math.round(ctx)}%`, color: severity(ctx) })
    if (cost !== null) top.push({ text: `${formatUsd(cost)} · today ${formatUsd(today)} · 7d ${formatUsd(week)}` })

    const bottom: Part[] = windows.map(l => {
      const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const resetText = Number.isNaN(reset) ? '' : ` ↻${formatLeft(reset - at)}`
      const out = runsOutIn(started[l.kind], l, at)
      const outText = out === null ? '' : ` ⚠ out in ~${formatLeft(out)}`

      return {
        text: `${limitLabel(l.kind)} ${Math.round(l.percentUsed)}%${resetText}${outText}`,
        color: out !== null ? 'error' : severity(l.percentUsed),
      }
    })

    const { Box, Text } = $.ui.resolve(e)
    const row = (parts: Part[], key: string) => (
      <Box key={key} flexDirection="row">
        {parts.map((p, i) => (
          <Text key={String(i)} dimColor={p.color === undefined} color={p.color} wrap="truncate-end">
            {(i === 0 ? '' : '  ·  ') + p.text}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {row(top, 'top')}
        {bottom.length > 0 ? row(bottom, 'limits') : null}
      </Box>
    )
  })
}
