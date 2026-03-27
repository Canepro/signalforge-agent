import { AuthError, isRetryableApiFailure } from "./api.ts";
import type { ProcessJobResult } from "./job-runner.ts";

export function isRetryableRunLoopResult(result: ProcessJobResult): boolean {
  return result.kind === "error" && result.retryable === true;
}

export function isRetryableRunLoopError(error: unknown): boolean {
  if (error instanceof AuthError) return false;
  return isRetryableApiFailure(error);
}

export function nextRetryDelayMs(
  currentDelayMs: number,
  maxDelayMs: number
): { sleepMs: number; nextDelayMs: number } {
  const sleepMs = Math.min(currentDelayMs, maxDelayMs);
  return {
    sleepMs,
    nextDelayMs: Math.min(sleepMs * 2, maxDelayMs),
  };
}
