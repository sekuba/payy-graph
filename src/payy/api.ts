import { sleep } from '../log'

/** Public inputs of a utxo proof, hex without 0x prefix (see protocol.ts) */
export interface PublicInputs {
  input_commitments: [string, string]
  output_commitments: [string, string]
  messages: [string, string, string, string, string]
}

export interface PayyTxn {
  hash: string
  block_height: number
  index_in_block: number
  time: number
  proof: {
    public_inputs: PublicInputs
  }
}

/** The part of a transaction this project keeps: the export format */
export interface TxnSnapshot {
  hash: string
  block_height: number
  index_in_block: number
  time: number
  public_inputs: PublicInputs
}

export function toSnapshot(t: PayyTxn): TxnSnapshot {
  return {
    hash: t.hash,
    block_height: t.block_height,
    index_in_block: t.index_in_block,
    time: t.time,
    public_inputs: t.proof.public_inputs,
  }
}

interface ListTxnsResponse {
  txns: PayyTxn[]
  cursor: { after: string | null; before: string | null }
}

/**
 * Client for the public Payy node RPC
 * (payy repo: pkg/node/src/rpc/routes/configure.rs).
 */
export class PayyNode {
  constructor(private readonly baseUrl: string) {}

  /** Pages through history oldest first, at most 100 txns per page */
  async listTransactions(
    cursor: string | undefined,
    limit = 100,
  ): Promise<{ txns: PayyTxn[]; after: string | undefined }> {
    const params = new URLSearchParams({
      order: 'OldestToNewest',
      limit: String(limit),
    })
    if (cursor) params.set('cursor', cursor)
    const res = await this.get<ListTxnsResponse>(`/transactions?${params}`)
    return { txns: res.txns, after: res.cursor.after ?? undefined }
  }

  async getTransaction(hash: string): Promise<PayyTxn> {
    const res = await this.get<{ txn: PayyTxn }>(`/transactions/${hash}`)
    return res.txn
  }

  async getHeight(): Promise<number> {
    const res = await this.get<{ height: number }>('/height')
    return res.height
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
