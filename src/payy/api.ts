import { sleep } from '../log'

/** Public inputs of a utxo proof, hex without 0x prefix (see protocol.ts) */
export interface PublicInputs {
  input_commitments: [string, string]
  output_commitments: [string, string]
  messages: [string, string, string, string, string]
}

/** The part of a transaction this project keeps: the export format */
export interface TxnSnapshot {
  hash: string
  block_height: number
  index_in_block: number
  time: number
  public_inputs: PublicInputs
}

interface ListTxnsResponse {
  txns: (Omit<TxnSnapshot, 'public_inputs'> & {
    proof: { public_inputs: PublicInputs }
  })[]
  cursor: { after: string | null }
}

/**
 * Client for the public Payy node RPC
 * (payy repo: pkg/node/src/rpc/routes/configure.rs).
 */
export class PayyNode {
  constructor(private readonly baseUrl: string) {}

  /** Pages through history oldest first, 100 txns per page */
  async listTransactions(
    cursor: string | undefined,
  ): Promise<{ txns: TxnSnapshot[]; after: string | undefined }> {
    const params = new URLSearchParams({
      order: 'OldestToNewest',
      limit: '100',
    })
    if (cursor) params.set('cursor', cursor)
    const res = await this.get<ListTxnsResponse>(`/transactions?${params}`)
    return {
      txns: res.txns.map(({ proof, ...t }) => ({
        ...t,
        public_inputs: proof.public_inputs,
      })),
      after: res.cursor.after ?? undefined,
    }
  }

  private async get<T>(path: string): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(this.baseUrl + path, {
          signal: AbortSignal.timeout(120_000),
        })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return (await res.json()) as T
      } catch (e) {
        lastError = e
        await sleep(1000 * 2 ** attempt)
      }
    }
    throw new Error(`Payy node request failed: ${path}: ${String(lastError)}`)
  }
}
