import { describe, expect, test } from "bun:test";
import { ApiError, AuthError } from "../src/api.ts";
import {
  isRetryableRunLoopError,
  isRetryableRunLoopResult,
  nextRetryDelayMs,
} from "../src/run-loop.ts";

describe("run-loop", () => {
  test("marks retryable result errors explicitly", () => {
    expect(
      isRetryableRunLoopResult({
        kind: "error",
        code: 4,
        message: "temporary upstream failure",
        retryable: true,
      })
    ).toBe(true);
    expect(
      isRetryableRunLoopResult({
        kind: "error",
        code: 3,
        message: "collector failed",
      })
    ).toBe(false);
  });

  test("treats transient API failures as retryable", () => {
    expect(
      isRetryableRunLoopError(
        new ApiError("GET", "/api/agent/jobs/next", 503, "unavailable", null)
      )
    ).toBe(true);
    expect(
      isRetryableRunLoopError(
        new ApiError("GET", "/api/agent/jobs/next", 404, "missing", null)
      )
    ).toBe(false);
    expect(
      isRetryableRunLoopError(
        new AuthError("GET", "/api/agent/jobs/next", 401, "unauthorized", null)
      )
    ).toBe(false);
    expect(isRetryableRunLoopError(new TypeError("fetch failed"))).toBe(true);
  });

  test("caps exponential retry delay at the configured maximum", () => {
    expect(nextRetryDelayMs(30_000, 300_000)).toEqual({
      sleepMs: 30_000,
      nextDelayMs: 60_000,
    });
    expect(nextRetryDelayMs(300_000, 300_000)).toEqual({
      sleepMs: 300_000,
      nextDelayMs: 300_000,
    });
  });
});
