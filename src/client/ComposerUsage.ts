import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Api } from './api.js'
import { SIDEBAR_TTL_MS, loadCards } from './sidebar-api.js'
import { cardIdentity, formatResetDeadline, formatUsed, sidebarRows, usedLevel, type SidebarRow, type SidebarWindowRow } from './sidebar-view.js'
import { isMagpieRoute, type ModelDirectories } from './SpeedSelect.js'
import { formatTime, windowReading, type Card } from './view-model.js'
import { SIDEBAR_WINDOW_KINDS } from '../shared/sidebar-window.js'
import { t } from './locales.js'

/**
 * Usage line under the composer (`conversation.composer.dock`, the row that
 * also carries the context meter). It shows the quota windows of the upstream
 * that owns the session's current model, and renders nothing for any model
 * that is not one of this plugin's owner routes.
 */
const ROUTE_PREFIX = 'dsh-magpie-connector-'
/** Longer than the shared card cache TTL, so every tick finds the cache expired and really reads. */
const REFRESH_MS = SIDEBAR_TTL_MS + 5_000

export interface ComposerSelection { provider: string; model: string }
/** The two limits the composer line summarises. */
export type RingKind = 'fiveHour' | 'weekly'
export interface RingSummary { kind: RingKind; /** Mean used percent over the accounts that report this window. */ used: number; /** Earliest reset among those accounts. */ resetsAt?: string; accounts: number }

/**
 * One ring per limit: the mean usage across accounts that report it, and the
 * earliest reset (a single account simply shows its own reset).
 */
export function summarize(rows: SidebarRow[]): RingSummary[] {
  const out: RingSummary[] = []
  for (const kind of ['fiveHour', 'weekly'] as const) {
    const hits = rows.filter(row => !row.failed).flatMap(row => row.windows.filter(win => win.kind === kind && win.used !== undefined))
    if (hits.length === 0) continue
    const times = hits.map(win => Date.parse(win.window.resetsAt ?? '')).filter(time => !Number.isNaN(time))
    const earliest = times.length === 0 ? undefined : new Date(Math.min(...times)).toISOString()
    out.push({ kind, used: hits.reduce((sum, win) => sum + win.used!, 0) / hits.length, ...(earliest ? { resetsAt: earliest } : {}), accounts: hits.length })
  }
  return out
}

export type ComposerView = { kind: 'hidden' } | { kind: 'status'; text: string } | { kind: 'rows'; rows: SidebarRow[]; matched: boolean }

/** Owner key of the current model's route, or undefined when it is not one of ours. */
export const ownerOfSelection = (selection: ComposerSelection | null): string | undefined =>
  selection !== null && isMagpieRoute(selection.provider) ? selection.provider.slice(ROUTE_PREFIX.length) : undefined

/** Cards of the owning upstream; `matched` is false when none carries the owner's name and every card is shown instead. */
export function cardsForOwner(cards: Card[], owner: string): { cards: Card[]; matched: boolean } {
  const key = owner.toLowerCase()
  const hit = cards.filter(card => card.provider.toLowerCase() === key || (card.name ?? '').toLowerCase() === key)
  return hit.length > 0 ? { cards: hit, matched: true } : { cards, matched: false }
}

export function createCurrentSelection(models: () => ModelDirectories | undefined, sessionId: string): () => Promise<ComposerSelection | null> {
  return async () => {
    const directories = models()
    if (directories === undefined) return null
    return (await directories.directoryFor(sessionId).load()).current
  }
}

export function ComposerUsage({ api, loadSelection, watchModel }: { api?: Api; loadSelection?: () => Promise<ComposerSelection | null>; watchModel?: (onChange: () => void) => () => void }) {
  const [view, setView] = useState<ComposerView>({ kind: 'hidden' })
  const [now, setNow] = useState(() => Date.now())
  const active = useRef(true)
  const version = useRef(0)
  const lastOwner = useRef<string | undefined>(undefined)
  const loadRef = useRef(loadSelection)
  loadRef.current = loadSelection
  useEffect(() => {
    if (!api || !loadSelection) return
    active.current = true
    const run = async () => {
      const mine = ++version.current
      try {
        const load = loadRef.current
        if (!load) return
        const owner = ownerOfSelection(await load())
        if (!active.current || mine !== version.current) return
        // A different upstream must never show the previous upstream's readings while loading or failing.
        if (owner !== lastOwner.current) { lastOwner.current = owner; setView({ kind: 'hidden' }) }
        if (owner === undefined) return
        const result = await loadCards(api)
        if (!active.current || mine !== version.current) return
        if (result.status === 'forbidden') { setView({ kind: 'status', text: t('composerUsageForbidden') }); return }
        if (result.status !== 'ok') { setView({ kind: 'status', text: t('composerUsageUnavailable') }); return }
        const picked = cardsForOwner(result.cards, owner)
        setNow(Date.now())
        setView(picked.cards.length === 0 ? { kind: 'hidden' } : { kind: 'rows', rows: sidebarRows(picked.cards, SIDEBAR_WINDOW_KINDS), matched: picked.matched })
      } catch {
        // Keep readings already shown for this upstream; otherwise say so instead of staying blank.
        if (active.current && mine === version.current) setView(previous => previous.kind === 'rows' ? previous : { kind: 'status', text: t('composerUsageUnavailable') })
      }
    }
    void run()
    const timer = setInterval(() => { void run() }, REFRESH_MS)
    const unwatch = watchModel?.(() => { void run() }) ?? (() => {})
    return () => { active.current = false; version.current++; clearInterval(timer); unwatch() }
  }, [])
  if (view.kind === 'hidden') return null
  if (view.kind === 'status') return h('div', { className: 'dmg-cu', 'data-magpie-composer-usage': '', role: 'status' }, h('span', { className: 'dmg-cu-status' }, view.text))
  const rings = summarize(view.rows)
  if (rings.length === 0) return null
  return h('div', { className: 'dmg-cu', 'data-magpie-composer-usage': '' }, ...rings.map(ring => h(Ring, { key: ring.kind, ring, rows: view.rows, now })))
}

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const limitName = (kind: RingKind) => t(kind === 'fiveHour' ? 'composerLimit5h' : 'composerLimit7d')

/**
 * Rough time left until a reset, as a static string (it is not ticking):
 * `2 days 3 hours`, `3 hours 15 min`, `15 min 30 sec`. Undefined when the
 * timestamp is unparseable; an instant already passed reads as `0 sec`.
 */
export function formatCountdown(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined || resetsAt === '') return undefined
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return undefined
  const total = Math.max(0, Math.floor((at - now) / 1000))
  const d = Math.floor(total / 86400), h2 = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60
  if (d > 0) return t('composerCountdownDH', { d, h: h2 })
  if (h2 > 0) return t('composerCountdownHM', { h: h2, m })
  return t('composerCountdownMS', { m, s: sec })
}

export function tooltipText(ring: RingSummary, now: number): string {
  const used = formatUsed(ring.used)
  const reset = formatCountdown(ring.resetsAt, now)
  if (reset === undefined) return t('composerTipNoReset', { name: limitName(ring.kind), used })
  return t(ring.accounts > 1 ? 'composerTipEarliest' : 'composerTip', { name: limitName(ring.kind), used, reset, n: ring.accounts })
}

/** Place a fixed popup above its anchor, clamped into the viewport. */
function placeAbove(anchor: HTMLElement | null, width: number): { left: number; bottom: number } {
  const box = anchor?.getBoundingClientRect()
  if (!box) return { left: 12, bottom: 48 }
  const left = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 8))
  return { left, bottom: window.innerHeight - box.top + 8 }
}

function Ring({ ring, rows, now }: { ring: RingSummary; rows: SidebarRow[]; now: number }): ReactNode {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key) }
  }, [open])
  const used = Math.min(100, Math.max(0, ring.used))
  const level = usedLevel(used)
  const tip = tooltipText(ring, now)
  return h('span', { ref: rootRef, className: 'dmg-cu-ring', onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) },
    h('button', { type: 'button', className: 'dmg-cu-trigger', 'data-kind': ring.kind, 'data-level': level, 'aria-label': tip, 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(!open) },
      h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true },
        h('circle', { className: 'dmg-cu-track', cx: 7, cy: 7, r: RADIUS }),
        h('circle', { className: 'dmg-cu-fill', cx: 7, cy: 7, r: RADIUS, strokeDasharray: `${CIRCUMFERENCE * used / 100} ${CIRCUMFERENCE}`, transform: 'rotate(-90 7 7)' })),
      h('span', null, `${limitName(ring.kind)} ${formatUsed(used)}`)),
    hover && !open ? createPortal(h('div', { className: 'dmg-cu-tip', role: 'tooltip', style: placeAbove(rootRef.current, 260) }, tip), document.body) : null,
    open ? createPortal(h('div', { ref: panelRef, className: 'dmg-cu-panel', role: 'dialog', 'aria-label': limitName(ring.kind), style: placeAbove(rootRef.current, 300) },
      h('div', { className: 'dmg-cu-panel-head' }, h('strong', null, t('composerPanelTitle')), h('span', null, tip)),
      ...rows.map(row => panelAccount(row, now))), document.body) : null)
}

function panelAccount(row: SidebarRow, now: number): ReactNode {
  const title = [row.card.name ?? row.card.provider, row.card.user].filter(Boolean).join(' · ')
  const body = row.failed
    ? [h('div', { key: 'err', className: 'dmg-cu-line' }, t('usageReadingFailed'))]
    : row.windows.length === 0
      ? [h('div', { key: 'bal', className: 'dmg-cu-line' }, `${t('usageBalance')} ${row.balance ?? '—'}`)]
      : row.windows.map((win, index) => {
        const reset = formatResetDeadline(win.window.resetsAt, now)
        return h('div', { key: index, className: 'dmg-cu-line', ...(win.window.resetsAt ? { title: `${t('usageResetAt')}${formatTime(win.window.resetsAt)}` } : {}) },
          h('span', { className: 'dmg-cu-label' }, win.window.name ?? '—'),
          h('span', { className: 'dmg-cu-pct', ...(win.used === undefined ? {} : { 'data-level': usedLevel(win.used) }) }, win.used !== undefined ? formatUsed(win.used) : windowReading(win.window) ?? '—'),
          h('span', { className: 'dmg-cu-reset' }, reset === undefined ? '—' : `↻ ${reset}`),
          win.used === undefined ? null : h('div', { className: 'dmg-cu-bar', 'aria-hidden': true }, h('i', { 'data-level': usedLevel(win.used), style: { width: `${win.used}%` } })))
      })
  return h('section', { key: cardIdentity(row.card), className: 'dmg-cu-account' }, h('div', { className: 'dmg-cu-account-name' }, title), ...body)
}
