import { TxKind } from '../protocol'
import type { Subgraph } from './closure'

export interface Bounds {
  /** exact value when the graph determines it */
  value?: number
  min: number
  max?: number
}

/**
 * Note values are hidden, but every transaction conserves value:
 *
 *   sum(inputs) + minted = sum(outputs) + burned
 *
 * and minted and burned amounts are public. Treating each note as an unknown
 * gives one linear equation per transaction. Solving the system exactly
 * tells which notes the public amounts pin down: along a path without splits
 * or merges every amount, and also across a split that merges back, where
 * the two branches stay unknown but their sum does not. Notes the equations
 * leave open get bounds instead, since a note cannot exceed what flowed into
 * its transaction.
 */
export function inferAmounts(
  graph: Pick<Subgraph, 'txns' | 'notes'>,
): Map<string, Bounds> {
  const equations = new Map(
    [...graph.txns.values()].map((t) => [
      t.hash,
      {
        inputs: [] as string[],
        outputs: [] as string[],
        minted: t.kind === TxKind.Mint ? t.amount : 0,
        burned: t.kind === TxKind.Burn ? t.amount : 0,
      },
    ]),
  )
  for (const n of graph.notes.values()) {
    if (n.spent_tx) equations.get(n.spent_tx)?.inputs.push(n.commitment)
    if (n.created_tx) equations.get(n.created_tx)?.outputs.push(n.commitment)
  }

  // Exact values: sum(inputs) - sum(outputs) = burned - minted, one row per tx
  const value = solve(
    [...equations.values()].map((eq) => {
      const row = new Map<string, bigint>()
      for (const n of eq.inputs) row.set(n, (row.get(n) ?? 0n) + 1n)
      for (const n of eq.outputs) row.set(n, (row.get(n) ?? 0n) - 1n)
      return { coefficients: row, constant: BigInt(eq.burned - eq.minted) }
    }),
  )

  // Bounds for the rest by interval arithmetic on each equation: an unknown
  // on one side equals the other side minus its own side's other terms, so
  // its interval follows from theirs (a known value is a point, a note with
  // no upper bound yet counts as unbounded). Repeat until nothing tightens.
  const min = new Map<string, number>()
  const max = new Map<string, number>()
  const lo = (n: string) => value.get(n) ?? min.get(n) ?? 0
  const hi = (n: string) => value.get(n) ?? max.get(n)
  const sumLo = (notes: string[]) => notes.reduce((a, n) => a + lo(n), 0)
  const sumHi = (notes: string[]) =>
    notes.reduce<number | undefined>((a, n) => {
      const h = hi(n)
      return a === undefined || h === undefined ? undefined : a + h
    }, 0)
  for (let round = 0; round < 50; round++) {
    let tightened = false
    const tighten = (n: string, newLo: number, newHi: number | undefined) => {
      if (newLo > lo(n)) {
        min.set(n, newLo)
        tightened = true
      }
      const h = hi(n)
      if (newHi !== undefined && (h === undefined || newHi < h)) {
        max.set(n, Math.max(newHi, 0))
        tightened = true
      }
    }
    for (const eq of equations.values()) {
      const side = (
        own: string[],
        other: string[],
        ownConst: number,
        otherConst: number,
      ) => {
        for (const n of own) {
          if (value.has(n)) continue
          const rest = own.filter((m) => m !== n)
          const otherHi = sumHi(other)
          const restHi = sumHi(rest)
          // n = other + otherConst - ownConst - rest
          const newLo =
            sumLo(other) +
            otherConst -
            ownConst -
            (restHi ?? Number.POSITIVE_INFINITY)
          const newHi =
            otherHi === undefined
              ? undefined
              : otherHi + otherConst - ownConst - sumLo(rest)
          tighten(n, Math.max(0, newLo), newHi)
        }
      }
      side(eq.inputs, eq.outputs, eq.minted, eq.burned)
      side(eq.outputs, eq.inputs, eq.burned, eq.minted)
    }
    if (!tightened) break
  }

  const result = new Map<string, Bounds>()
  for (const n of graph.notes.keys()) {
    const v = value.get(n)
    result.set(
      n,
      v !== undefined
        ? { value: v, min: v, max: v }
        : { min: min.get(n) ?? 0, max: max.get(n) },
    )
  }
  return result
}

interface Equation {
  coefficients: Map<string, bigint>
  constant: bigint
}

/**
 * Gauss-Jordan elimination over exact rationals. Returns the variables whose
 * value the system determines: after reduction, a pivot row with no other
 * variable left. Negative solutions mean the data is inconsistent and are
 * dropped.
 */
function solve(equations: Equation[]): Map<string, number> {
  type Row = { coefficients: Map<string, Fraction>; constant: Fraction }
  const rows: Row[] = equations.map((eq) => ({
    coefficients: new Map(
      [...eq.coefficients]
        .filter(([, v]) => v !== 0n)
        .map(([k, v]) => [k, fraction(v)] as const),
    ),
    constant: fraction(eq.constant),
  }))
  // rows each variable occurs in, kept up to date as elimination fills in,
  // so a pivot only touches the rows that contain its variable
  const occurs = new Map<string, Set<Row>>()
  for (const row of rows) {
    for (const k of row.coefficients.keys()) {
      const set = occurs.get(k) ?? new Set()
      set.add(row)
      occurs.set(k, set)
    }
  }
  const used = new Set<Row>()
  const pivots: { variable: string; row: Row }[] = []
  for (const [variable, rowsWith] of occurs) {
    // the sparsest unused row keeps fill-in low
    let row: Row | undefined
    for (const r of rowsWith) {
      if (used.has(r)) continue
      if (!row || r.coefficients.size < row.coefficients.size) row = r
    }
    if (!row) continue
    used.add(row)
    const scale = inverse(row.coefficients.get(variable) ?? ONE)
    for (const [k, v] of row.coefficients)
      row.coefficients.set(k, mul(v, scale))
    row.constant = mul(row.constant, scale)
    for (const other of [...rowsWith]) {
      if (other === row) continue
      const factor = other.coefficients.get(variable)
      if (!factor) continue
      for (const [k, v] of row.coefficients) {
        const next = sub(other.coefficients.get(k) ?? ZERO, mul(factor, v))
        if (isZero(next)) {
          other.coefficients.delete(k)
          occurs.get(k)?.delete(other)
        } else {
          other.coefficients.set(k, next)
          occurs.get(k)?.add(other)
        }
      }
      other.constant = sub(other.constant, mul(factor, row.constant))
    }
    pivots.push({ variable, row })
  }
  const result = new Map<string, number>()
  for (const { variable, row } of pivots) {
    if (row.coefficients.size !== 1) continue
    const { num, den } = row.constant
    if (num % den !== 0n || num < 0n) continue
    result.set(variable, Number(num / den))
  }
  return result
}

interface Fraction {
  num: bigint
  den: bigint
}

const ZERO: Fraction = { num: 0n, den: 1n }
const ONE: Fraction = { num: 1n, den: 1n }

function fraction(n: bigint): Fraction {
  return { num: n, den: 1n }
}

function normalize(num: bigint, den: bigint): Fraction {
  if (den < 0n) {
    num = -num
    den = -den
  }
  const g = gcd(num < 0n ? -num : num, den)
  return { num: num / g, den: den / g }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b]
  return a === 0n ? 1n : a
}

function mul(a: Fraction, b: Fraction): Fraction {
  return normalize(a.num * b.num, a.den * b.den)
}

function sub(a: Fraction, b: Fraction): Fraction {
  return normalize(a.num * b.den - b.num * a.den, a.den * b.den)
}

function inverse(a: Fraction): Fraction {
  return normalize(a.den, a.num)
}

function isZero(a: Fraction): boolean {
  return a.num === 0n
}
