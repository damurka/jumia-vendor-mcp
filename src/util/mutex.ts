/**
 * A minimal async mutex - there is no built-in JS equivalent of Python's
 * `asyncio.Lock`. Serializes calls to `runExclusive` by chaining onto a
 * tail promise: each call waits for the previous one to finish before its
 * function runs, regardless of how long that function takes or whether it
 * throws.
 *
 * Used wherever the Python version relied on `asyncio.Lock()`: the
 * double-checked-locking token refresh guard (auth.ts), the sliding-window
 * rate limiter (http.ts), and the lazy client/audit singleton (server.ts).
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // `this.tail` is constructed below to never itself reject, so
    // chaining with a single `.then(fn)` is enough - fn always runs once
    // its turn comes, regardless of whether the previous fn threw.
    const run = this.tail.then(fn);
    // Swallow rejections in the chain itself so one failed call doesn't
    // permanently wedge the mutex for everyone queued after it - the
    // caller of runExclusive still sees the real rejection via `run`.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
