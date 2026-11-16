/**
 * Live-snapshot pull cache: keep one sidecar round trip off the agent's
 * per-step critical path.
 *
 * `agent/pre-step` runs before every model step. Pulling a fresh snapshot
 * synchronously each time made a slow or wedged sidecar cost the full timeout
 * on *every* step, which users experience as "the assistant got slow". The
 * cache returns the last good snapshot immediately and refreshes it in the
 * background, so only the first step (and the first step after a failure
 * cooldown) can wait — and only for `timeoutMs`.
 *
 * @module @deepseek-ai/dsh-starhub-live-context/snapshot-cache
 */

/** Cache timings; all budgets flow in from plugin Config. */
export interface SnapshotCacheOptions {
  /** Hard budget for one pull; the first step waits at most this long. */
  timeoutMs: number
  /** Age beyond which a cached snapshot is refreshed in the background. */
  ttlMs: number
  /** After a failed pull, stop retrying for this long (no per-step stall). */
  cooldownMs: number
}

/** Clock seam for tests; production uses `Date.now`. */
export type Now = () => number

/**
 * One pull's single-flight refresh state.
 * @internal
 */
interface RefreshState {
  promise: Promise<void>
}

/**
 * Stale-while-revalidate cache for `starhub/live.snapshot`.
 */
export class LiveSnapshotCache {
  private snapshot: unknown
  private fetchedAt = 0
  private failedAt = 0
  private refreshState: RefreshState | undefined

  /**
   * @param options - pull budget, cache TTL, and failure cooldown.
   * @param now - clock seam (tests pass a manual clock).
   */
  constructor(private readonly options: SnapshotCacheOptions, private readonly now: Now = Date.now) {}

  /**
   * Read the snapshot, refreshing opportunistically.
   *
   * - cached value present → answered immediately; a stale one triggers a
   *   background refresh (never awaited by the caller);
   * - no cached value → one bounded pull, so the first step pays at most
   *   `timeoutMs`;
   * - recent failure → no pull at all during the cooldown.
   * @param pull - performs one sidecar request.
   * @returns the newest known snapshot, or undefined when none is available.
   */
  async get(pull: () => Promise<unknown>): Promise<unknown> {
    const now = this.now()
    if (this.snapshot !== undefined) {
      if (now - this.fetchedAt >= this.options.ttlMs) this.refresh(pull)
      return this.snapshot
    }
    const inflight = this.refreshState
    if (inflight !== undefined) {
      await inflight.promise
      return this.snapshot
    }
    if (now - this.failedAt < this.options.cooldownMs) return undefined
    await this.refresh(pull)?.promise
    return this.snapshot
  }

  /**
   * Start (or join) one bounded background refresh.
   * @param pull - performs one sidecar request.
   * @returns the refresh state, or undefined while cooling down.
   */
  private refresh(pull: () => Promise<unknown>): RefreshState | undefined {
    if (this.refreshState !== undefined) return this.refreshState
    if (this.now() - this.failedAt < this.options.cooldownMs) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = Promise.resolve()
      .then(() => pull())
      .then((value) => {
        if (typeof value === 'object' && value !== null) {
          this.snapshot = value
          this.fetchedAt = this.now()
          this.failedAt = 0
        } else {
          // 非对象(空/字符串)按"没有这份快照"降级,不算失败,不进入冷却。
          this.failedAt = this.now()
        }
      }, () => {
        this.failedAt = this.now()
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer)
        this.refreshState = undefined
      })
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.timeoutMs)
      timer.unref()
    })
    const state: RefreshState = { promise: Promise.race([pending, timeout]) }
    this.refreshState = state
    return state
  }
}
