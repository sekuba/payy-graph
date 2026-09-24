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
 * public graph shows happened to the notes Payy's server issued at the
 * migration, one line each for links, ramps and the card, and what the
 * data does not show. Every figure links to a transaction or a line of
 * Payy's published code, and each is marked as proved or suggested.
 * Definitions are in src/graph/keys.ts.
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
          The figures are not computed yet; the sync fills them in.
        </p>
      )}
      {stats && <Migration stats={stats} onSelect={onSelect} />}
      {stats && <Flows stats={stats} onSelect={onSelect} />}
      <NotShown />
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        <Tag kind="proves" /> follows from the public chain data or Payy's
        published code alone. <Tag kind="suggests" /> is consistent with them,
        but another explanation is possible. Code links point at commit{' '}
        <Code ref="" text={PAYY_COMMIT.slice(0, 7)} /> of Payy's repository.
      </p>
    </div>
  )
}

/** Payy's sentence, and what kind of note it does not cover */
function Claim() {
  return (
    <section className="card grid gap-2 p-3 text-sm">
      <h2 className="font-semibold">Who holds the keys</h2>
      <blockquote
        className="border-l-2 pl-3"
        style={{ borderColor: 'var(--axis)', color: 'var(--ink-2)' }}
      >
        “Payy is a non-custodial stablecoin wallet. This means the private key
        that lets you control your crypto is stored on your device, accessible
        by only you.”{' '}
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
        A Payy wallet holds two kinds of notes. The notes the app creates for
        itself have keys it derives on the device from the wallet key{' '}
        <Code ref={PAYY_CODE.derivedKey} /> <Code ref={PAYY_CODE.deriveFn} />.
        Notes that arrive from Payy's server carry an explicit key the server
        made or saw, which the app stores as <em>provided</em>{' '}
        <Code ref={PAYY_CODE.keyKinds} />: the balances re-issued at the 2025
        migration, payment links, ramp deposits and the card. The server keeps
        notes with their private keys by owner{' '}
        <Code ref={PAYY_CODE.notesTable} /> <Code ref={PAYY_CODE.ownerId} /> and
        spends them by owner <Code ref={PAYY_CODE.assign} />{' '}
        <Code ref={PAYY_CODE.transfer} />. The app's own spending code is not
        published, so what became of such notes is read off the chain.
      </p>
    </section>
  )
}

const FIRST_LABEL: Record<FirstSpend, string> = {
  unspent: 'never spent',
  rekey: 'a send with one input and one output',
  send: 'a payment with change',
  card: 'a card payment',
  merge: 'a merge with another note',
  burn: 'a withdrawal',
  other: 'something else',
}

const FIRST_NOTE: Record<FirstSpend, string> = {
  unspent: 'still spendable today with the key Payy generated, if Payy kept it',
  rekey:
    'the shape of the wallet moving the balance to a key of its own; also the shape Payy uses before its own withdrawals',
  send: 'the note paid someone and kept the change, under the key Payy generated',
  card: 'the note was sent to the card collector, whose merges withdraw in batches, under the key Payy generated',
  merge:
    'the note was consolidated with another one, under the key Payy generated',
  burn: 'the note was withdrawn to L1, under the key Payy generated',
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
    ['unspent', 'rekey', 'send', 'card', 'merge', 'burn', 'other'] as const
  ).filter((f) => m.first[f].count > 0)
  const pct = (n: number) => `${Math.round((100 * n) / m.payouts)}%`
  const direct =
    m.first.send.count +
    m.first.card.count +
    m.first.merge.count +
    m.first.burn.count
  const directSpent = [m.first.send, m.first.card, m.first.merge, m.first.burn]
  const directMin = directSpent.reduce((a, s) => a + s.min, 0)
  const pending = m.payouts - m.classified
  return (
    <section className="card grid gap-3 p-3 text-sm">
      <h3 className="font-semibold">
        The migration: {m.payouts.toLocaleString('en-US')} notes issued under
        keys Payy generated
      </h3>
      <p style={{ color: 'var(--ink-2)' }}>
        On {date(m.start).slice(0, 10)} Payy moved every balance of its previous
        chain to this one. The app sent the server each old note with its
        private key <Code ref={PAYY_CODE.migrateRequest} />{' '}
        <Code ref={PAYY_CODE.migrateClient} />, and the server answered with new
        notes and their private keys <Code ref={PAYY_CODE.migrateResponse} />:
        keys the server held before the app did, drawn at random on its side{' '}
        <Code ref={PAYY_CODE.randomKey} /> <Tag kind="proves" />. A Payy wallet
        paid the notes out from {usdc(m.deposited)} USDC of treasury deposits
        between {date(m.start)} and {date(m.end)} UTC, so the{' '}
        {m.payouts.toLocaleString('en-US')} notes held that much together, less
        the change Payy kept at the end of {m.change} payout chains{' '}
        <Tag kind="proves" />. What each note held is hidden; the graph pins it
        down only where the note was later withdrawn in full.
      </p>
      <p style={{ color: 'var(--ink-2)' }}>
        A wallet that wanted these notes out of Payy's reach would spend each to
        a key of its own as soon as it saw it: a send with one input and one
        output, minutes after issue. What the chain shows instead, for the first
        spend of each note:
      </p>
      <table className="stack w-full text-left text-xs">
        <thead style={{ color: 'var(--muted)' }}>
          <tr>
            <th className="py-1 font-normal">First spent by</th>
            <th className="py-1 text-right font-normal">Notes</th>
            <th className="py-1 text-right font-normal">Median wait</th>
            <th className="py-1 text-right font-normal">Within an hour</th>
            <th className="py-1 text-right font-normal">Held, where known</th>
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
              <td colSpan={4} />
            </tr>
          )}
        </tbody>
      </table>
      <ul className="grid gap-1" style={{ color: 'var(--ink-2)' }}>
        <li>
          <Tag kind="proves" /> {m.first.unspent.count.toLocaleString('en-US')}{' '}
          notes ({pct(m.first.unspent.count)}) have never been spent,{' '}
          {days(m.first.unspent.medianHeld)} after issue. Whoever holds the key
          Payy generated for them can spend them; nothing else can.
        </li>
        <li>
          <Tag kind="proves" /> {direct.toLocaleString('en-US')} notes (
          {pct(direct)}) were spent straight from the key Payy generated: a
          payment, a merge, a card charge or a withdrawal took the note as its
          input, with median waits from{' '}
          {days(Math.min(...directSpent.map((s) => s.medianHeld)))} to{' '}
          {days(Math.max(...directSpent.map((s) => s.medianHeld)))} after issue.
          Together they held at least {cents(directMin)} USDC.
        </li>
        <li>
          <Tag kind="suggests" /> {m.first.rekey.count.toLocaleString('en-US')}{' '}
          notes ({pct(m.first.rekey.count)}) were first spent by a send with one
          input and one output, the shape of a wallet moving the balance to a
          key of its own. Only {m.first.rekey.withinHour} did so within an hour
          of issue and {m.first.rekey.withinDay} within a day; the median waited{' '}
          {days(m.first.rekey.medianHeld)}. The same shape precedes Payy's own
          withdrawals (below), so the chain does not tell who made these.
        </li>
        <li>
          <Tag kind="proves" /> {m.first.card.count.toLocaleString('en-US')}{' '}
          notes paid the card straight from the migrated note, a median of{' '}
          {days(m.first.card.medianHeld)} after issue; the longest waited{' '}
          {days(m.first.card.maxHeld)}. <Tag kind="suggests" /> Card charges
          follow the merchant's schedule (the recurring ones fall within seconds
          of the same minute each month), so the app need not have been open
          when the note was spent.
        </li>
        <li>
          <Tag kind="proves" /> {m.first.burn.count.toLocaleString('en-US')}{' '}
          notes were withdrawn to L1 straight from the migrated note, a median
          of {days(m.first.burn.medianHeld)} after issue, {usdc(m.burned)} USDC
          in all.
        </li>
        <li>
          <Tag kind="proves" /> In all, {m.spent.withinHour} of the{' '}
          {m.spent.count.toLocaleString('en-US')} notes spent so far were spent
          within an hour of issue and {m.spent.withinDay} within a day; the
          median first spend came {days(m.spent.medianHeld)} after issue. Every
          note sat under a key Payy generated until then, and{' '}
          {m.first.unspent.count.toLocaleString('en-US')} still do.
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
        {first === 'unspent'
          ? `${days(s.medianHeld)} so far`
          : days(s.medianHeld)}
      </td>
      <td className="mono py-1 text-right" data-label="within an hour">
        {first === 'unspent' ? '' : s.withinHour}
      </td>
      <td className="mono py-1 text-right" data-label="held">
        {held(s)}
      </td>
      <td className="py-1" data-label="example">
        {example && <Example note={example} onSelect={onSelect} />}
      </td>
    </tr>
  )
}

/** What the notes of one kind held: exact where known, else the lower bound */
function held(s: HeldStats): string {
  if (s.count === 0) return ''
  if (s.exact === s.count) return `${cents(s.exactSum)} USDC`
  if (s.exact > 0) {
    return `${s.exact} exact: ${cents(s.exactSum)} · all ≥ ${cents(s.min)} USDC`
  }
  return s.min > 0 ? `≥ ${cents(s.min)} USDC` : 'hidden'
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
    <span className="mono whitespace-nowrap">
      <button
        type="button"
        className="underline"
        title={`${note.spentTx ? 'spent by' : 'issued by'} ${tx}; click to open it here`}
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

/** Links, ramps and the card, one line each, and the sweeps */
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
      <h3 className="font-semibold">Links, ramps and the card</h3>
      <ul className="grid gap-1" style={{ color: 'var(--ink-2)' }}>
        <li>
          <Tag kind="proves" /> <strong>Links.</strong> A payment link carries
          the note's private key <Code ref={PAYY_CODE.linkKey} />, and the app
          registers such notes with the server, key included{' '}
          <Code ref={PAYY_CODE.createNote} />. The recipient's app spends a
          received note to a key of its own, a claim{' '}
          <Code ref={PAYY_CODE.claim} />.
        </li>
        <li>
          <Tag kind="proves" /> <strong>Ramps.</strong> A ramp deposit is
          delivered to the app as a private key <Code ref={PAYY_CODE.rampKey} />
          .
        </li>
        <li>
          <Tag kind="proves" /> <strong>Card.</strong> A card payment is a note
          sent to Payy's collector, which merges and withdraws the payments in
          batches; that is custodial by design and out of scope here, except
          that the card charges from migrated notes above were made with the key
          Payy's server held.
        </li>
        <li>
          <Tag kind="suggests" /> <strong>Sweeps.</strong>{' '}
          {s.count.toLocaleString('en-US')} transactions up to height{' '}
          {s.height.toLocaleString('en-US')} consume a note at least a day old
          (median {days(s.medianAge)}) together with one made in the ten minutes
          before, the two from separate histories;{' '}
          {s.withDeposit.toLocaleString('en-US')} of the fresh notes are
          deposits, and {s.intoBurn.toLocaleString('en-US')} of the merges reach
          a withdrawal within a few transactions. In{' '}
          {s.small.toLocaleString('en-US')} the graph bounds the old note to at
          most one USDC: {cents(s.smallSum)} USDC of leftovers in all
          {s.open > 0
            ? `; ${s.open.toLocaleString('en-US')} old notes have no upper bound`
            : ''}
          . A wallet consolidating its own change looks the same, so this is
          counted, not attributed.
          {example && (
            <>
              {' '}
              Newest small one:{' '}
              <SweepExample sweep={example} onSelect={onSelect} />
            </>
          )}
        </li>
        {b.computedAt > 0 && (
          <li>
            <Tag kind="suggests" /> <strong>Withdrawals without change.</strong>{' '}
            <Shape s={b.noChange} what="burned a whole note" />{' '}
            <Shape s={b.withChange} what="kept change" /> Which side makes these
            sends is not visible; a wallet withdrawing its own note has no need
            to move it to another key first.
          </li>
        )}
      </ul>
    </section>
  )
}

function Shape({ s, what }: { s: BurnShape; what: string }) {
  const share = s.count ? (100 * s.afterRekey) / s.count : 0
  const pct = share >= 1 || share === 0 ? Math.round(share) : share.toFixed(1)
  return (
    <>
      Of the {s.count.toLocaleString('en-US')} withdrawals that {what},{' '}
      {s.afterRekey.toLocaleString('en-US')} ({pct}%) burned a note that a
      one-input, one-output send had made, a median of {duration(s.medianGap)}{' '}
      before ({s.within10min.toLocaleString('en-US')} within ten minutes).
    </>
  )
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
    <span className="mono whitespace-nowrap">
      <button
        type="button"
        className="underline"
        title={`${sweep.tx}; click to open it here`}
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
      <h3 className="font-semibold">What this does not show</h3>
      <p style={{ color: 'var(--ink-2)' }}>
        A plain deposit, sends between current wallets and a withdrawal keep the
        keys on the device as far as the published code and the chain show: the
        app derives the keys of its own notes{' '}
        <Code ref={PAYY_CODE.derivedKey} /> and moves a received note to a key
        of its own with a claim <Code ref={PAYY_CODE.claim} />. Nothing here
        says otherwise. The finding is narrower: part of an ordinary balance
        consists of notes whose keys Payy's server generated or received, and
        for the migrated notes the chain shows those keys were still the ones
        spending, months later.
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
          : 'consistent with the data, but another explanation is possible'
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
