import { useEffect, useState } from 'react'
import type {
  BurnShape,
  FirstSpend,
  HeldStats,
  KeyStats,
  MigratedNote,
} from '../../src/graph/types'
import {
  PAYY_CODE,
  PAYY_COMMIT,
  PAYY_FAQ_URL,
  payyCodeUrl,
} from '../../src/protocol'
import { Address } from './Address'
import { api } from './api'
import { date, payyTxUrl, shortHex, usdc } from './format'

/**
 * Whose keys spend the notes in users' wallets: Payy's sentence, what the
 * chain shows happened to the notes Payy's server issued at the migration,
 * one line each for links, ramps and the card, and what the data does not
 * show. Every figure links to a transaction or a line of Payy's code, and
 * each is marked as proved or suggested. Definitions in src/graph/keys.ts.
 */
export function Keys({
  onSelect,
  initial,
}: {
  onSelect: (query: string) => void
  /** figures to show without asking the API, for rendering it elsewhere */
  initial?: KeyStats
}) {
  const [stats, setStats] = useState<KeyStats | undefined>(initial)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (initial) return
    api
      .keys()
      .then((k) =>
        'migration' in k ? setStats(k as KeyStats) : setError(true),
      )
      .catch(() => setError(true))
  }, [initial])
  return (
    <div className="grid gap-3">
      <Claim />
      {error && (
        <p style={{ color: 'var(--muted)' }}>
          The figures are not computed yet. The sync fills them in.
        </p>
      )}
      {stats && <Migration stats={stats} onSelect={onSelect} />}
      {stats && <Flows stats={stats} onSelect={onSelect} />}
      <NotShown />
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        <Tag kind="proves" /> follows from the chain data or Payy's code alone.{' '}
        <Tag kind="suggests" /> fits them, other explanations possible. Code
        links point at commit <Code ref="" text={PAYY_COMMIT.slice(0, 7)} />.
      </p>
    </div>
  )
}

/** Payy's sentence, and the kind of note it does not cover */
function Claim() {
  return (
    <section className="card grid gap-2 p-3 text-sm">
      <h2 className="font-semibold">Who holds the keys</h2>
      <blockquote
        className="border-l-2 pl-3"
        style={{ borderColor: 'var(--payy-line)', color: 'var(--ink-2)' }}
      >
        “The private key that lets you control your crypto is stored on your
        device, accessible by only you.”{' '}
        <a
          href={PAYY_FAQ_URL}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Payy Wallet FAQ
        </a>
      </blockquote>
      <p style={{ color: 'var(--ink-2)' }}>
        That holds for the notes the app makes for itself, whose keys it derives
        on the device <Code ref={PAYY_CODE.derivedKey} />. Notes that arrive
        from Payy's server, at the 2025 migration or through links, ramps and
        the card, come with a key the server made or saw{' '}
        <Code ref={PAYY_CODE.keyKinds} />. The server keeps such keys by owner{' '}
        <Code ref={PAYY_CODE.notesTable} /> and spends by owner{' '}
        <Code ref={PAYY_CODE.assign} />.
      </p>
    </section>
  )
}

const FIRST_LABEL: Record<FirstSpend, string> = {
  unspent: 'nothing yet',
  rekey: 'a 1-in/1-out send',
  send: 'a payment',
  card: 'a card payment',
  merge: 'a merge',
  burn: 'a withdrawal',
  other: 'something else',
}

const FIRST_NOTE: Record<FirstSpend, string> = {
  unspent: 'still spendable with the key Payy generated',
  rekey:
    'the shape of a wallet moving the balance to its own key, and of the sends before Payy’s own withdrawals',
  send: 'paid someone and kept the change, under the key Payy generated',
  card: 'sent to the card collector, under the key Payy generated',
  merge: 'consolidated with another note, under the key Payy generated',
  burn: 'withdrawn to L1, under the key Payy generated',
  other: '',
}

/** What became of the notes Payy issued at the migration */
function Migration({
  stats,
  onSelect,
}: {
  stats: KeyStats
  onSelect: (query: string) => void
}) {
  const m = stats.migration
  const rows = (
    ['unspent', 'rekey', 'send', 'merge', 'card', 'burn', 'other'] as const
  ).filter((f) => m.first[f].count > 0)
  const pct = (n: number) => `${Math.round((100 * n) / m.payouts)}%`
  const direct = [m.first.send, m.first.card, m.first.merge, m.first.burn]
  const directCount = direct.reduce((a, s) => a + s.count, 0)
  const directMin = direct.reduce((a, s) => a + s.min, 0)
  const pending = m.payouts - m.classified
  return (
    <section className="card grid gap-3 p-3 text-sm">
      <h3 className="font-semibold">Custodial migration</h3>
      <p style={{ color: 'var(--ink-2)' }}>
        On {date(m.start).slice(0, 10)} the app sent Payy's server every old
        note with its private key <Code ref={PAYY_CODE.migrateRequest} />, and
        the server issued {m.payouts.toLocaleString('en-US')} new notes with
        keys of its own making <Code ref={PAYY_CODE.migrateResponse} />{' '}
        <Code ref={PAYY_CODE.randomKey} />, {usdc(m.deposited)} USDC together{' '}
        <Tag kind="proves" />. A wallet wanting them out of Payy's reach would
        re-key each at once with a 1-in/1-out send. What first spent each note:
      </p>
      <table className="stack w-full text-left text-xs">
        <thead style={{ color: 'var(--muted)' }}>
          <tr>
            <th className="py-1 font-normal">First spent by</th>
            <th className="py-1 text-right font-normal">Notes</th>
            <th className="py-1 text-right font-normal">Median wait</th>
            <th className="py-1 font-normal">Example</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <HeldRow
              key={f}
              first={f}
              s={m.first[f]}
              share={pct(m.first[f].count)}
              onSelect={onSelect}
            />
          ))}
          {pending > 0 && (
            <tr className="hairline border-t" style={{ color: 'var(--muted)' }}>
              <td className="py-1">not classified yet</td>
              <td className="mono py-1 text-right">{pending}</td>
              <td colSpan={2} />
            </tr>
          )}
        </tbody>
      </table>
      <ul className="grid gap-1" style={{ color: 'var(--ink-2)' }}>
        <li>
          <Tag kind="proves" /> {m.first.unspent.count.toLocaleString('en-US')}{' '}
          notes ({pct(m.first.unspent.count)}) are still unspent after{' '}
          {days(m.first.unspent.medianHeld)}. Only the key Payy generated can
          spend them.
        </li>
        <li>
          <Tag kind="proves" /> {directCount.toLocaleString('en-US')} notes (
          {pct(directCount)}) were spent straight from that key. They held at
          least {cents(directMin)} USDC.
        </li>
        <li>
          <Tag kind="suggests" /> {m.first.rekey.count.toLocaleString('en-US')}{' '}
          notes ({pct(m.first.rekey.count)}) were first moved by a 1-in/1-out
          send, the shape of a re-key. Only {m.first.rekey.withinHour} within an
          hour of issue and {m.first.rekey.withinDay} within a day. Payy's own
          withdrawals show the same shape (below).
        </li>
        <li>
          <Tag kind="suggests" /> Card charges run on the merchant's schedule,
          so the app need not have been open. The longest waited{' '}
          {days(m.first.card.maxHeld)}.
        </li>
      </ul>
    </section>
  )
}

function HeldRow({
  first,
  s,
  share,
  onSelect,
}: {
  first: FirstSpend
  s: HeldStats
  share: string
  onSelect: (query: string) => void
}) {
  const example = s.examples[0]
  return (
    <tr className="row hairline border-t" title={FIRST_NOTE[first]}>
      <td className="py-1">{FIRST_LABEL[first]}</td>
      <td className="mono py-1 text-right" data-label="notes">
        {s.count.toLocaleString('en-US')}{' '}
        <span style={{ color: 'var(--muted)' }}>· {share}</span>
      </td>
      <td className="mono py-1 text-right" data-label="median wait">
        {days(s.medianHeld)}
        {first === 'unspent' ? ' so far' : ''}
      </td>
      <td className="wide py-1" data-label="example">
        {example && <Example note={example} onSelect={onSelect} />}
      </td>
    </tr>
  )
}

/** One migrated note: the transaction that spent it, or the one that issued it */
function Example({
  note,
  onSelect,
}: {
  note: MigratedNote
  onSelect: (query: string) => void
}) {
  const tx = note.spentTx ?? note.createdTx
  const what =
    note.value !== undefined
      ? `${usdc(note.value)} USDC`
      : note.min > 0
        ? `≥ ${usdc(note.min)} USDC`
        : undefined
  return (
    <span className="mono">
      <button
        type="button"
        className="underline"
        title={`${note.spentTx ? 'spent by' : 'issued by'} ${tx}. Click to open it here`}
        onClick={() => onSelect(tx)}
      >
        {shortHex(tx, 4)}
      </button>{' '}
      <a
        href={payyTxUrl(tx)}
        target="_blank"
        rel="noreferrer"
        style={{ color: 'var(--muted)' }}
        title="on Payy's explorer"
      >
        ↗
      </a>
      <span style={{ color: 'var(--muted)' }}>
        {' '}
        · {days(note.held)}
        {what ? ` · ${what}` : ''}
        {note.burnAddr && (
          <>
            {' → '}
            <Address address={note.burnAddr} />
          </>
        )}
      </span>
    </span>
  )
}

/** Links, ramps and the card, one line each, then the sweeps */
function Flows({
  stats,
  onSelect,
}: {
  stats: KeyStats
  onSelect: (query: string) => void
}) {
  const s = stats.sweeps
  const b = stats.burns
  const example = s.examples[0]
  return (
    <section className="card grid gap-2 p-3 text-sm">
      <h3 className="font-semibold">Links, ramps, card</h3>
      <ul className="grid gap-1" style={{ color: 'var(--ink-2)' }}>
        <li>
          <Tag kind="proves" /> <strong>Links.</strong> The link carries the
          note's private key <Code ref={PAYY_CODE.linkKey} />, the app registers
          it with the server <Code ref={PAYY_CODE.createNote} />, and the
          recipient re-keys it with a claim <Code ref={PAYY_CODE.claim} />.
        </li>
        <li>
          <Tag kind="proves" /> <strong>Ramps.</strong> A ramp deposit arrives
          as a private key <Code ref={PAYY_CODE.rampKey} />.
        </li>
        <li>
          <Tag kind="proves" /> <strong>Card.</strong> Payments go to Payy's
          collector. Custodial by design.
        </li>
        <li>
          <Tag kind="suggests" /> <strong>Sweeps.</strong>{' '}
          {s.count.toLocaleString('en-US')} merges join a note over a day old
          with one made minutes before, from separate histories. In{' '}
          {s.small.toLocaleString('en-US')} the old note is at most one USDC,{' '}
          {cents(s.smallSum)} USDC in all. A wallet tidying its own change looks
          the same.
          {example && (
            <>
              {' '}
              Newest: <SweepExample sweep={example} onSelect={onSelect} />
            </>
          )}
        </li>
        {b.computedAt > 0 && (
          <li>
            <Tag kind="suggests" /> <strong>Re-key before withdrawal.</strong>{' '}
            <Shape s={b.noChange} what="burned a whole note" /> Of the{' '}
            {b.withChange.count.toLocaleString('en-US')} that kept change,{' '}
            {b.withChange.afterRekey.toLocaleString('en-US')} (
            {pct(b.withChange)}%). A wallet withdrawing its own note has no need
            to move it first.
          </li>
        )}
      </ul>
    </section>
  )
}

function Shape({ s, what }: { s: BurnShape; what: string }) {
  return (
    <>
      Of the {s.count.toLocaleString('en-US')} withdrawals that {what},{' '}
      {s.afterRekey.toLocaleString('en-US')} ({pct(s)}%) burned a note made by a
      1-in/1-out send a median of {duration(s.medianGap)} earlier.
    </>
  )
}

/** The share of a shape's withdrawals that followed a 1-in/1-out send */
function pct(s: BurnShape): string {
  const share = s.count ? (100 * s.afterRekey) / s.count : 0
  return share >= 1 || share === 0
    ? String(Math.round(share))
    : share.toFixed(1)
}

function SweepExample({
  sweep,
  onSelect,
}: {
  sweep: KeyStats['sweeps']['examples'][number]
  onSelect: (query: string) => void
}) {
  const o = sweep.old
  const amount =
    o.value !== undefined
      ? usdc(o.value)
      : o.max !== undefined
        ? `≤ ${usdc(o.max)}`
        : `≥ ${usdc(o.min)}`
  return (
    <span className="mono">
      <button
        type="button"
        className="underline"
        title={`${sweep.tx}. Click to open it here`}
        onClick={() => onSelect(sweep.tx)}
      >
        {shortHex(sweep.tx, 4)}
      </button>
      <span style={{ color: 'var(--muted)' }}>
        {' '}
        · {amount} USDC, {days(o.age)} old, with a{' '}
        {sweep.fresh.deposit ? 'deposit' : 'note'} {sweep.fresh.age} s old
        {sweep.burn && (
          <>
            {' → '}
            {usdc(sweep.burn.amount)} USDC to{' '}
            <Address address={sweep.burn.recipient} /> {sweep.burn.hops}{' '}
            {sweep.burn.hops === 1 ? 'transaction' : 'transactions'} later
          </>
        )}
      </span>
    </span>
  )
}

/** What the data does not show */
function NotShown() {
  return (
    <section className="card grid gap-2 p-3 text-sm">
      <h3 className="font-semibold">Not shown</h3>
      <p style={{ color: 'var(--ink-2)' }}>
        Deposits, sends between current wallets and withdrawals keep the keys on
        the device as far as the code and the chain show{' '}
        <Code ref={PAYY_CODE.derivedKey} /> <Code ref={PAYY_CODE.claim} />. The
        point is narrower: part of an ordinary balance is notes whose keys
        Payy's server held.
      </p>
    </section>
  )
}

function Tag({ kind }: { kind: 'proves' | 'suggests' }) {
  return (
    <span
      className={`chip ${kind === 'proves' ? 'chip-strong' : ''}`}
      title={
        kind === 'proves'
          ? 'follows from the public chain data or the published code alone'
          : 'fits the data, but another explanation is possible'
      }
    >
      {kind}
    </span>
  )
}

/** A link to a passage of Payy's code, shown as its file name and lines */
function Code({ ref, text }: { ref: string; text?: string }) {
  const [path, lines] = ref.split('#')
  const file = path?.split('/').pop() ?? ''
  const range = lines?.replace(/^L/, '').replace('-L', '–') ?? ''
  return (
    <a
      href={payyCodeUrl(ref)}
      target="_blank"
      rel="noreferrer"
      className="mono"
      style={{ color: 'var(--muted)', fontSize: '11px' }}
      title={ref ? `${path} lines ${range}` : 'the repository at this commit'}
    >
      {text ?? `${file}:${range}`}
    </a>
  )
}

/** A sum of bounds, which has micro precision, shown to the cent */
function cents(amount: number): string {
  return usdc(Math.round(amount / 10_000) * 10_000)
}

/** Seconds as days, or hours below a day */
function days(seconds: number): string {
  const d = seconds / 86400
  if (d >= 2) return `${Math.round(d)} days`
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`
  return duration(seconds)
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${m % 60} min`
  return `${Math.round(h / 24)} days`
}
