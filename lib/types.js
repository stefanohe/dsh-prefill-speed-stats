/**
 * Plain-JSON shapes shared by the Host fold, the wire view, and the Client
 * strip. The Host and Client halves are separate module graphs, so the shapes are
 * declared once here and revalidated on the wire by the Host projection's schema
 * (`lib/projection.js`).
 *
 * Token convention, matching the harness token meter: `usage.inputTokens` is the
 * UNCACHED part of the prompt, so `inputTokens` here is the whole prompt —
 * `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`.
 *
 * @module dsh-prefill-speed-stats/lib/types
 */

/**
 * Cumulative counters over a set of model steps.
 *
 * @typedef {object} SpeedCounters
 * @property {number} steps
 * @property {number} inputTokens          whole prompt: cached + uncached
 * @property {number} uncachedInputTokens  the part the provider had to compute
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} ttftMs               summed first-token latency
 * @property {number} decodeMs             summed decode wall time
 */

/**
 * One measured scope, with the tokens and wall times that produced it. Every
 * speed is `null` until both of its operands have been observed.
 *
 * @typedef {SpeedCounters & {
 *   input: number | null,
 *   inputUncached: number | null,
 *   output: number | null,
 *   cachedInputTokens: number,
 * }} SpeedValue
 */

/**
 * The published last-N window: sums over the most recently closed measured steps,
 * plus the window size the algorithm targets. `steps` is the number actually in
 * the window, which stays below `window` until the session has that many.
 *
 * @typedef {object} SpeedWindow
 * @property {number} steps
 * @property {number} inputTokens
 * @property {number} uncachedInputTokens
 * @property {number} ttftMs
 * @property {number} window
 */

/**
 * The projection's client-visible value, as `useProjection('sessionSpeed')`
 * delivers it. Every speed the strip shows is derived by the Client from these
 * sums, because the two algorithms differ only in which steps they sum over.
 *
 * All sums cover MEASURED steps only — a step with no first token has no prefill
 * window, so its tokens are pooled in `unmeasuredInputTokens` instead of entering
 * any rate.
 *
 * @typedef {object} SpeedView
 * @property {SpeedValue & {
 *   turns: number,
 *   averageTtftMs: number | null,
 *   averageLlmMs: number | null,
 *   unmeasuredInputTokens: number,
 * }} session
 *   whole-log sums over measured steps
 * @property {SpeedWindow | null} realtime
 *   sums over the last `window` measured steps; `null` until one has closed
 * @property {null} currentTurn
 *   always `null`: per-turn rows are not published, so the view carries no
 *   per-turn state
 * @property {null} lastTurn
 *   always `null`, for the same reason
 * @property {{ turns: number, steps: number, llmMs: number, toolMs: number }} totals
 *   mirrors of the built-in `sessionStats` figures
 */
