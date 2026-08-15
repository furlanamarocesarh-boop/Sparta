/**
 * A bounded `fetch` for the E2E suites.
 *
 * WHY THIS EXISTS. The E2E helpers called bare `fetch`, which has NO default
 * timeout. When the Functions emulator accepted the TCP connection but never
 * answered — exactly what happened while it failed to load the functions module —
 * the request stayed pending forever. A run was observed hanging for 1h54m with
 * the test process at 0% CPU and a single ESTABLISHED socket to 127.0.0.1:5001.
 * A suite that hangs is worse than one that fails: it reports nothing, blocks the
 * emulator's ports and has to be killed by hand.
 *
 * The rule this encodes: an E2E request either completes or fails, always within
 * a bounded time. `AbortSignal.timeout` aborts the underlying request, so the
 * socket is released rather than merely abandoned — no orphaned connection, no
 * held port, and `emulators:exec` can shut down cleanly.
 *
 * This lives in `test/support/` (not `test/e2e/`) so `npm run test:e2e`'s
 * `*.test.js` glob never picks it up as a suite, while a unit test can still
 * import and prove its behaviour without any real network.
 */

/** Generous enough for a cold emulator call, far below any human patience. */
export const E2E_HTTP_TIMEOUT_MS = 15_000;

/**
 * `fetch` that is guaranteed to settle.
 *
 * On expiry it throws a plain `Error` naming the method, the URL and the budget,
 * so a failing suite says WHICH call stalled instead of printing an opaque
 * `AbortError`. Every other failure propagates untouched.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = E2E_HTTP_TIMEOUT_MS
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as { name?: unknown })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      const method = (init.method ?? "GET").toString().toUpperCase();
      throw new Error(
        `E2E HTTP timeout após ${timeoutMs}ms: ${method} ${url} — ` +
          `o emulador aceitou a conexão mas não respondeu.`
      );
    }
    throw error;
  }
}
