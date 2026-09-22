export function log(message: string, fields?: Record<string, unknown>): void {
  const time = new Date().toISOString().slice(11, 19)
  const extra = fields
    ? ` ${Object.entries(fields)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ')}`
    : ''
  process.stdout.write(`${time} ${message}${extra}\n`)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
