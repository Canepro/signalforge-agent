/** stderr-only operational logging */

export function logInfo(msg: string): void {
  console.error(`[signalforge-agent] ${msg}`);
}

export function logWarn(msg: string): void {
  console.error(`[signalforge-agent] WARN: ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[signalforge-agent] ERROR: ${msg}`);
}
