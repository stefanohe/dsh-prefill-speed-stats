/**
 * `sessionSpeed`: the Host-side fold behind the prefill-speed strip.
 *
 * ## Why this unit exists
 *
 * The shipped `sessionStats` projection publishes a strict SUBSET of its fold
 * state: it accumulates the decode window but publishes neither the prompt-side
 * token total nor any per-turn boundary. Prefill speed therefore cannot be
 * derived from it on the Client. This unit folds the SAME durable step
 * boundaries — so its figures stay consistent with `sessionStats` — and
 * additionally carries the prompt-token buckets.
 *
 * ## The two algorithms
 *
 * Both operate on the same numerator and denominator terms:
 *
 *   uncached tokens = usage.inputTokens
 *   prefill window  = step/start -> first visible token of the step's stream
 *
 * `usage.inputTokens` is the UNCACHED part of the prompt — the harness
 * convention, not an inference: the token meter maps that field to
 * `uncachedInputTokens`, and its context-pressure fold sums
 * `inputTokens + cacheReadTokens + cacheWriteTokens` to get the whole prompt.
 * So counting only `usage.inputTokens` counts exactly the prompt the provider had
 * to COMPUTE, which is the work prefill speed is meant to describe. A prompt
 * served mostly from cache is cheap, and this figure says so.
 *
 *   1. session average = Σ uncached tokens / Σ prefill windows   (measured steps, whole log)
 *   2. last-N window   = Σ uncached tokens / Σ prefill windows   (measured steps, most recent)
 *
 * Both are published as raw sums, never as a pre-divided rate: a published
 * average would hide the step count behind it, and the Client labels that count.
 * `view()` therefore exposes `inputTokens`/`uncachedInputTokens` and `ttftMs` as
 * sums over the SAME set of steps.
 *
 * ## One accumulator, on purpose
 *
 * `state.turn` holds every measured step of the session; there is no second
 * running total. A session accumulator and a running per-turn accumulator cover
 * overlapping sets of steps, so with both present every reader has to decide which
 * one to add — and adding both would count the same steps twice.
 *
 * The whole-log sums are therefore `state.turn` PLUS the step that has not closed
 * yet — one addition with one possible mistake, and the tests pin it.
 *
 * ## Measured steps only
 *
 * A step that produced no visible token has no prefill window. Its tokens are
 * real, but its elapsed time cannot be split into prefill and decode, so counting
 * one without the other biases the figure. Both algorithms therefore take
 * measured steps only — the rule a throughput benchmark applies when it discards
 * an incomplete request — and the excluded tokens are pooled in
 * `unmeasuredInputTokens` so the amount left out stays visible.
 *
 * ## Time and token boundaries (identical to the built-in fold)
 *
 *   llm time    = step/start -> assistant/message
 *   TTFT        = step/start -> first visible token of the step's stream
 *   decode time = first visible token -> assistant/message
 *
 * `step/end` — not `assistant/message` — is the counted step event, as in the
 * built-in fold, because the loop appends exactly one per entered step. An
 * assembled message SETTLES its step (so a retry cannot add usage to a window
 * that already closed); `step/end` closes it and moves the counters into the
 * accumulator.
 *
 * ## What makes the reading move (read this before judging a number)
 *
 * The figure is `uncached tokens / prefill window`, so four influences dominate and
 * only the first is about the model being fast:
 *
 *   1. HOW MUCH OF THE PROMPT IS NEW. The numerator counts only what the provider
 *      had to compute, so a prefix-cache hit costs nothing. The same 2.3s window
 *      reads ~25 000 tok/s for a step with 58 000 uncached tokens and ~77 tok/s for
 *      a step with 176 — same wait, 330x less to read.
 *   2. FIXED LATENCY, which a small numerator cannot amortize: queueing, the
 *      network round trip, and reading the KV cache of the cached part. When few
 *      tokens are new, that fixed part is nearly the whole window and the reading
 *      collapses regardless of hardware.
 *   3. WHICH STEPS A ROW COVERS. The session average sums every measured step, so
 *      it reflects the workload the session ran most; the last-N row reflects the
 *      current workload. A session that moved from cold large prompts to small
 *      incremental steps shows a much lower last-N row — different work, not a
 *      different speed.
 *   4. PROMPT SIZE, slightly: the same tokens cost more per token in a longer
 *      context (attention and KV traffic).
 *
 * Measured example from a real 863-step session (99.6% cache hits,
 * `unmeasuredInputTokens` 0): session average 1 448 777 / 1 493 197 ms =
 * 970 tok/s; last ten 7 040 / 22 985 ms = 306 tok/s. Those ten steps read 704
 * uncached tokens each against a 2 299 ms average window, so at the session's own
 * rate those tokens would take 0.7s — the remaining ~22s did not depend on how many
 * tokens were new.
 *
 * The rule for a reader: to call a low reading "slow", check the numerator. A small
 * numerator means there was little new to compute.
 *
 * ## The prefill window is a lower bound on throughput
 *
 * The window is the provider's time-to-first-token, which also contains queueing,
 * network round trips, KV-cache reads and request processing. The published figure
 * is therefore "new prompt tokens computed per second of waiting for the first
 * token" — a perceived-throughput reading, not a pure GPU prefill benchmark. For
 * the session average the fixed part is a roughly constant offset averaged against
 * a large token sum; for a short window it dominates, which is why a last-N reading
 * can sit far below the session average without the model being slower. No baseline
 * is subtracted: that would trade a small, well-understood bias for a larger,
 * unverifiable one.
 *
 * NOTHING IN THIS FILE MAY THROW OUTWARD. The unit is folded inside every
 * session's drive and its value crosses the client's read path; in this
 * deployment a throw there fails that entry's activation and the application
 * refuses to start. `apply`, `view` and both schemas are guarded: they degrade
 * (freeze the strip, pass the value through) and report once on the console.
 *
 * @module dsh-prefill-speed-stats/lib/projection
 */

const { assistantStreamFirstTokenTime } = require('./stream.js');

/** The projection key; also the name the Client reads through `useProjection`. */
const SPEED_PROJECTION_KEY = 'sessionSpeed';

/**
 * Bump when folded fields or their meaning change. Stored checkpoints carrying
 * an older version are discarded and refolded from the durable log.
 *
 * v8: one accumulator (`state.turn`) replaces the session+turn pair, and the
 * per-turn snapshots are no longer published.
 */
const SPEED_PROJECTION_STATE_VERSION = 8;

/** Key of the non-enumerable view cache, kept off the checkpointed state. */
const VIEW = Symbol('sessionSpeed.view');

/** Every counter field a scope carries; the schemas below enforce exactly this set. */
const COUNTER_FIELDS = [
  'steps',
  'inputTokens',
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'ttftMs',
  'decodeMs',
];

/** How many recent measured steps the last-N window keeps. */
const REALTIME_WINDOW = 10;

/** One console warning per label per process: a bad fold must not spam. */
const REPORTED = new Set();

/** @param {string} label @param {unknown} error */
function reportOnce(label, error) {
  if (REPORTED.has(label)) return;
  REPORTED.add(label);
  try {
    const detail = error !== null && error !== undefined && error.message !== undefined ? error.message : error;
    // eslint-disable-next-line no-console
    console.warn(`[prefill-speed-stats] ${label}: ${String(detail)}`);
  } catch (ignored) {
    // A console that throws is not worth a second thought.
  }
}

/** @returns {import('./types.js').SpeedCounters} */
function emptyCounters() {
  return {
    steps: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ttftMs: 0,
    decodeMs: 0,
  };
}

/** @returns {any} */
function emptyState() {
  return {
    rev: 0,
    /** Every measured step of the session. The ONLY accumulator (see the note above). */
    turn: emptyCounters(),
    /** Identity of the turn those counters belong to, or null before the first close. */
    closedTurn: null,
    /** The open step's boundary facts, including what its `assistant/message` measured. */
    open: null,
    /**
     * Per-step measurements of at most {@link REALTIME_WINDOW} measured steps,
     * oldest first. The last-N reading is the ratio of sums over this ring.
     *
     * Read it ONLY through {@link recentRing}, which reads a missing or non-array
     * field as an empty ring: a state written before this field existed has no
     * array here.
     */
    recent: [],
    /**
     * Uncached tokens read by steps that produced no first token. They are NOT in
     * the speed aggregates (no window can be attributed to them); they are kept so
     * the amount left out of the rate stays visible. Read through
     * {@link unmeasuredPool} for the same reason as the ring.
     */
    unmeasuredInputTokens: 0,
    totals: { turns: 0, steps: 0, llmMs: 0, toolMs: 0 },
    pendingCalls: {},
    collecting: false,
  };
}

/**
 * The measure ring of a state, or an empty array when the state predates the
 * field (or carries something that is not an array). Total by construction: one
 * missing field must cost a reading, never a session.
 *
 * @param {any} state
 */
function recentRing(state) {
  return Array.isArray(state.recent) ? state.recent : [];
}

/**
 * Append one closed step to the ring, keeping at most {@link REALTIME_WINDOW}
 * entries. A step without a measured window is dropped: it carries no prefill
 * measurement, and letting it in would drag the reading toward zero.
 *
 * Only these three figures ever enter the ring. A full counter object is the easy
 * mistake here: the ring is summed as one step's tokens and window, so anything
 * else in it silently corrupts the last-N reading.
 *
 * @param {any} state
 * @param {import('./types.js').SpeedCounters} counted
 */
function pushRecent(state, counted) {
  if (!(counted.ttftMs > 0)) return recentRing(state);
  const entry = {
    uncachedInputTokens: counted.uncachedInputTokens,
    inputTokens: counted.inputTokens,
    ttftMs: counted.ttftMs,
  };
  return recentRing(state).concat([entry]).slice(-REALTIME_WINDOW);
}

/**
 * Sums over one ring, or `null` when it holds no step. Malformed entries are
 * skipped rather than fatal.
 *
 * @param {readonly any[]} ring
 * @returns {{ steps: number, uncachedInputTokens: number, inputTokens: number, ttftMs: number } | null}
 */
function ringTotals(ring) {
  if (ring.length === 0) return null;
  const totals = { steps: 0, uncachedInputTokens: 0, inputTokens: 0, ttftMs: 0 };
  for (const entry of ring) {
    if (entry === null || typeof entry !== 'object') continue;
    totals.steps += 1;
    totals.uncachedInputTokens += Number.isFinite(entry.uncachedInputTokens) ? entry.uncachedInputTokens : 0;
    totals.inputTokens += Number.isFinite(entry.inputTokens) ? entry.inputTokens : 0;
    totals.ttftMs += Number.isFinite(entry.ttftMs) ? entry.ttftMs : 0;
  }
  return totals.steps === 0 ? null : totals;
}

/**
 * A minimal schema. The projection registry only ever calls `.parse(value)` on
 * a unit's schemas, so this validates at exactly the same boundary a zod schema
 * would while keeping the Host half free of a runtime dependency.
 *
 * `parse` never throws (see the module note): a violation is reported once and
 * the value is passed through.
 *
 * @param {string} label
 * @param {(value: any) => void} check
 */
function schema(label, check) {
  return {
    parse(value) {
      try {
        check(value);
      } catch (error) {
        reportOnce(`${label} validation`, error);
      }
      return value;
    },
    describe: () => label,
  };
}

/** @param {string} label @param {any} value */
function requireRecord(label, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object, got ${value === null ? 'null' : typeof value}`);
  }
}

/** @param {string} label @param {any} value */
function requireCount(label, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}: expected a finite non-negative number, got ${String(value)}`);
  }
}

/** @param {string} label @param {any} value */
function requireNullableCount(label, value) {
  if (value === null) return;
  requireCount(label, value);
}

/** @param {string} label @param {any} value */
function checkCounters(label, value) {
  requireRecord(label, value);
  for (const field of COUNTER_FIELDS) requireCount(`${label}.${field}`, value[field]);
}

/**
 * The measure ring holds three figures per step, not a full counter set, so it
 * needs its own shape here: {@link checkCounters} requires every
 * {@link COUNTER_FIELDS} field. A validator that disagrees with its data only
 * teaches the reader to ignore warnings.
 *
 * @param {string} label @param {any} value
 */
function checkRingEntry(label, value) {
  requireRecord(label, value);
  for (const field of ['uncachedInputTokens', 'inputTokens', 'ttftMs']) requireCount(`${label}.${field}`, value[field]);
}

const stateSchema = schema('SessionSpeedState', (value) => {
  requireRecord('sessionSpeed state', value);
  requireCount('sessionSpeed state.rev', value.rev);
  checkCounters('sessionSpeed state.turn', value.turn);
  // `closedTurn` is validated only when present: a state written before the field
  // existed must still parse, because a schema violation here would discard the
  // whole session's projection.
  if (value.closedTurn !== undefined) requireNullableCount('sessionSpeed state.closedTurn', value.closedTurn);
  if (value.open !== null) {
    requireRecord('sessionSpeed state.open', value.open);
    requireCount('sessionSpeed state.open.turn', value.open.turn);
    requireCount('sessionSpeed state.open.step', value.open.step);
    requireCount('sessionSpeed state.open.startTime', value.open.startTime);
    requireNullableCount('sessionSpeed state.open.firstTokenTime', value.open.firstTokenTime);
    if (value.open.closed !== null) checkCounters('sessionSpeed state.open.closed', value.open.closed);
    // A persisted state may still carry the `consumed` / `countedLlm` boundary
    // flags, so they are validated only when present: rejecting such a state would
    // discard its whole projection.
    if (value.open.consumed !== undefined && typeof value.open.consumed !== 'boolean') {
      throw new Error('sessionSpeed state.open.consumed: expected a boolean');
    }
    if (value.open.countedLlm !== undefined && typeof value.open.countedLlm !== 'boolean') {
      throw new Error('sessionSpeed state.open.countedLlm: expected a boolean');
    }
  }
  requireRecord('sessionSpeed state.totals', value.totals);
  for (const field of ['turns', 'steps', 'llmMs', 'toolMs']) requireCount(`sessionSpeed state.totals.${field}`, value.totals[field]);
  if (Array.isArray(value.recent)) {
    for (let index = 0; index < value.recent.length; index += 1) {
      checkRingEntry(`sessionSpeed state.recent[${index}]`, value.recent[index]);
    }
  }
  if (value.unmeasuredInputTokens !== undefined) {
    requireCount('sessionSpeed state.unmeasuredInputTokens', value.unmeasuredInputTokens);
  }
  requireRecord('sessionSpeed state.pendingCalls', value.pendingCalls);
  if (typeof value.collecting !== 'boolean') throw new Error('sessionSpeed state.collecting: expected a boolean');
});

const viewSchema = schema('SessionSpeedView', (value) => {
  requireRecord('sessionSpeed view', value);
  requireRecord('sessionSpeed view.session', value.session);
  for (const field of ['input', 'inputUncached', 'output', 'averageTtftMs', 'averageLlmMs']) {
    requireNullableCount(`sessionSpeed view.session.${field}`, value.session[field]);
  }
  for (const field of COUNTER_FIELDS) requireCount(`sessionSpeed view.session.${field}`, value.session[field]);
  for (const field of ['cachedInputTokens', 'uncachedInputTokens', 'inputTokens', 'unmeasuredInputTokens', 'turns']) {
    requireCount(`sessionSpeed view.session.${field}`, value.session[field]);
  }
  if (value.realtime !== null) {
    requireRecord('sessionSpeed view.realtime', value.realtime);
    requireCount('sessionSpeed view.realtime.steps', value.realtime.steps);
    requireCount('sessionSpeed view.realtime.uncachedInputTokens', value.realtime.uncachedInputTokens);
    requireCount('sessionSpeed view.realtime.ttftMs', value.realtime.ttftMs);
    requireCount('sessionSpeed view.realtime.window', value.realtime.window);
  }
  requireRecord('sessionSpeed view.totals', value.totals);
  for (const field of ['turns', 'steps', 'llmMs', 'toolMs']) requireCount(`sessionSpeed view.totals.${field}`, value.totals[field]);
});

/**
 * Tokens per second, or `null` when the denominator is not a usable
 * measurement — so "not measured" stays distinguishable from "measured zero".
 *
 * @param {number} tokens
 * @param {number} ms
 * @returns {number | null}
 */
function tokensPerSecond(tokens, ms) {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || ms <= 0 || tokens < 0) return null;
  return (tokens / ms) * 1000;
}

/**
 * @param {import('./types.js').SpeedCounters} counters
 * @returns {import('./types.js').SpeedValue}
 */
function speedView(counters) {
  return {
    input: tokensPerSecond(counters.inputTokens, counters.ttftMs),
    inputUncached: tokensPerSecond(counters.uncachedInputTokens, counters.ttftMs),
    output: tokensPerSecond(counters.outputTokens, counters.decodeMs),
    inputTokens: counters.inputTokens,
    uncachedInputTokens: counters.uncachedInputTokens,
    cachedInputTokens: counters.cacheReadTokens + counters.cacheWriteTokens,
    cacheReadTokens: counters.cacheReadTokens,
    cacheWriteTokens: counters.cacheWriteTokens,
    outputTokens: counters.outputTokens,
    reasoningTokens: counters.reasoningTokens,
    ttftMs: counters.ttftMs,
    decodeMs: counters.decodeMs,
    steps: counters.steps,
  };
}

/**
 * @param {import('./types.js').SpeedCounters} base
 * @param {import('./types.js').SpeedCounters} step
 * @returns {import('./types.js').SpeedCounters}
 */
function accumulate(base, step) {
  return {
    steps: base.steps + step.steps,
    inputTokens: base.inputTokens + step.inputTokens,
    uncachedInputTokens: base.uncachedInputTokens + step.uncachedInputTokens,
    cacheReadTokens: base.cacheReadTokens + step.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + step.cacheWriteTokens,
    outputTokens: base.outputTokens + step.outputTokens,
    reasoningTokens: base.reasoningTokens + step.reasoningTokens,
    ttftMs: base.ttftMs + step.ttftMs,
    decodeMs: base.decodeMs + step.decodeMs,
  };
}

/** @param {any} usage @param {string} field @returns {number} */
function usageCount(usage, field) {
  const value = usage[field];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One provider usage sample, decomposed.
 *
 * `usage.inputTokens` is the UNCACHED part of the prompt, so the prompt the
 * model actually read is the sum of all three input buckets.
 *
 * @param {any} usage
 */
function decompose(usage) {
  const uncached = usageCount(usage, 'inputTokens');
  const cacheRead = usageCount(usage, 'cacheReadTokens');
  const cacheWrite = usageCount(usage, 'cacheWriteTokens');
  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: uncached + cacheRead + cacheWrite,
    outputTokens: usageCount(usage, 'outputTokens'),
    reasoningTokens: usageCount(usage, 'reasoningTokens'),
  };
}

/**
 * Whether a step's counters carry a prefill MEASUREMENT: a first token arrived, so
 * the window from `step/start` to that token exists.
 *
 * @param {import('./types.js').SpeedCounters} counters
 */
function isMeasured(counters) {
  return counters.ttftMs > 0;
}

/**
 * Tokens read by steps that carry no prefill measurement. Read through this
 * accessor so a state written before the field existed cannot break a fold.
 *
 * @param {any} state
 */
function unmeasuredPool(state) {
  const value = state.unmeasuredInputTokens;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The fold body, kept separate so `apply` can guard it: the unit is mounted in
 * every session's drive, so nothing in here may throw outward.
 *
 * @param {any} state
 * @param {any} event
 */
function foldEvent(state, event) {
  switch (event.type) {
    case 'turn/start': {
      // Only the collecting flag moves: `state.turn` accumulates every measured step
      // of the session, so a repeated announcement for the turn already collecting
      // and a genuinely new turn both leave the counters untouched.
      return { ...state, rev: state.rev + 1, collecting: true };
    }

    case 'step/start':
      // A new boundary replaces whatever was open, and it takes over every later
      // event: counters enter the accumulator only in the `step/end` case, and
      // `turn/end` pools only the boundary still open when it arrives. A displaced
      // step whose own `step/end` never came therefore reaches neither place.
      return {
        ...state,
        rev: state.rev + 1,
        collecting: true,
        open: {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
          firstTokenTime: null,
          closed: null,
        },
      };

    case 'assistant/attempt': {
      const open = state.open;
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state;
      // A settled step takes no more stream facts (see the message case).
      if (open.closed !== null && open.closed !== undefined) return state;
      // The step's first token latches from the FIRST attempt that carries one, and
      // a later attempt never rewrites it: the window is measured from `step/start`,
      // so re-latching it to a later attempt would shorten the window and inflate
      // the derived speed.
      if (open.firstTokenTime !== null) return state;
      const first = assistantStreamFirstTokenTime(event.data.stream);
      if (first === undefined) return state;
      return { ...state, rev: state.rev + 1, open: { ...open, firstTokenTime: first } };
    }

    case 'assistant/message': {
      const open = state.open;
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state;
      // One assembled message per step. A later message for the same step — an
      // `llm/retry` that re-announces it — settles nothing and changes nothing,
      // exactly as the built-in fold behaves when it clears its open boundary.
      if (open.closed !== null && open.closed !== undefined) return state;
      const first = assistantStreamFirstTokenTime(event.data.stream);
      const firstTokenTime = first === undefined ? open.firstTokenTime : open.firstTokenTime === null ? first : Math.min(open.firstTokenTime, first);
      const sample = event.data.usage === undefined || event.data.usage === null ? null : decompose(event.data.usage);
      const measured = {
        ...emptyCounters(),
        steps: 1,
        ttftMs: firstTokenTime === null ? 0 : Math.max(0, firstTokenTime - open.startTime),
        decodeMs: firstTokenTime === null ? 0 : Math.max(0, event.time - firstTokenTime),
      };
      const closed =
        sample === null
          ? measured
          : {
              ...measured,
              inputTokens: sample.inputTokens,
              uncachedInputTokens: sample.uncachedInputTokens,
              cacheReadTokens: sample.cacheReadTokens,
              cacheWriteTokens: sample.cacheWriteTokens,
              outputTokens: sample.outputTokens,
              reasoningTokens: sample.reasoningTokens,
            };
      return {
        ...state,
        rev: state.rev + 1,
        /**
         * The step is SETTLED but not yet closed: `step/end` still moves this
         * measurement into the accumulator, so the boundary stays, carrying what
         * this message measured. A second message for the same step is refused at
         * the guard above.
         */
        open: { turn: open.turn, step: open.step, startTime: open.startTime, firstTokenTime, closed },
        totals: { ...state.totals, llmMs: state.totals.llmMs + Math.max(0, event.time - open.startTime) },
      };
    }

    case 'step/end': {
      const open = state.open;
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state;
      const counted = open.closed === null || open.closed === undefined ? { ...emptyCounters(), steps: 1 } : open.closed;
      const measured = isMeasured(counted);
      return {
        ...state,
        rev: state.rev + 1,
        // The ONLY move of counters into the accumulator, and it happens exactly
        // once per step because `open` is cleared here.
        turn: measured ? accumulate(state.turn, counted) : state.turn,
        closedTurn: open.turn,
        open: null,
        recent: pushRecent(state, counted),
        unmeasuredInputTokens: measured ? unmeasuredPool(state) : unmeasuredPool(state) + counted.uncachedInputTokens,
        totals: {
          turns: state.totals.turns + (state.closedTurn === open.turn ? 0 : 1),
          steps: state.totals.steps + 1,
          llmMs: state.totals.llmMs,
          toolMs: state.totals.toolMs,
        },
      };
    }

    case 'tool/call':
      return { ...state, rev: state.rev + 1, pendingCalls: { ...state.pendingCalls, [event.data.callId]: event.time } };

    case 'tool/result': {
      // Own-key check: callId is provider-minted (model/tool JSON boundary), so a
      // prototype property name on a result with no recorded call must read as
      // unmatched rather than as an inherited function.
      const message = event.data.message;
      const callId = message === undefined || message === null || message.source === undefined || message.source === null ? undefined : message.source.callId;
      if (callId === undefined || !Object.hasOwn(state.pendingCalls, callId)) return state;
      const dispatched = state.pendingCalls[callId];
      const pendingCalls = Object.fromEntries(Object.entries(state.pendingCalls).filter(([id]) => id !== callId));
      return {
        ...state,
        rev: state.rev + 1,
        pendingCalls,
        totals: { ...state.totals, toolMs: state.totals.toolMs + Math.max(0, event.time - dispatched) },
      };
    }

    case 'turn/end': {
      // A call whose result never landed belongs to a cancelled or failed turn;
      // results always land within their turn, so drop the leftovers instead of
      // growing persisted state forever.
      const pendingCalls = Object.keys(state.pendingCalls).length === 0 ? state.pendingCalls : {};
      const open = state.open;
      /**
       * A step interrupted without its `step/end` cannot enter the accumulator —
       * the built-in fold counts steps on `step/end` and this unit keeps its
       * figures consistent with that — so whatever it read is POOLED instead of
       * silently dropped. That applies to a settled step with a measured window
       * too: without its `step/end` its tokens have no place in a rate, whether or
       * not it had a first token.
       */
      const unsettled = open !== null && open.closed !== null && open.closed !== undefined ? open.closed.uncachedInputTokens : 0;
      const untouched = pendingCalls === state.pendingCalls && !state.collecting && state.open === null && unsettled === 0;
      if (untouched) return state;
      return {
        ...state,
        rev: state.rev + 1,
        open: null,
        pendingCalls,
        unmeasuredInputTokens: unmeasuredPool(state) + unsettled,
        collecting: false,
      };
    }

    default:
      return state;
  }
}

/**
 * The projection's client-visible value.
 *
 * The whole-log sums are the accumulator plus the step that has not closed yet.
 * That single addition is the entire arithmetic of the published session row: the
 * accumulator already holds every step that closed, so adding any further set of
 * steps would count it twice.
 *
 * @param {any} state
 */
function viewOf(state) {
  const cached = state[VIEW];
  if (cached !== undefined && cached.rev === state.rev) return cached.value;

  const open = state.open;
  const openClosed = open === null || open.closed === null || open.closed === undefined ? null : open.closed;
  /**
   * The open step joins the sums only once it carries a measurement: an open step
   * with no first token has tokens but no window, and adding it would break the
   * "numerator and denominator describe the same steps" rule both algorithms rest
   * on.
   */
  const openMeasured = openClosed !== null && isMeasured(openClosed) ? openClosed : null;
  const live = openMeasured === null ? state.turn : accumulate(state.turn, openMeasured);
  const counters = speedView(live);

  const value = {
    session: {
      ...counters,
      turns: state.totals.turns,
      averageTtftMs: live.steps > 0 ? live.ttftMs / live.steps : null,
      averageLlmMs: state.totals.steps > 0 ? state.totals.llmMs / state.totals.steps : null,
      /** Tokens read by steps with no first token; excluded from every rate above. */
      unmeasuredInputTokens: unmeasuredPool(state) + (openMeasured === null && openClosed !== null ? openClosed.uncachedInputTokens : 0),
    },
    /**
     * The last-N window: sums over at most {@link REALTIME_WINDOW} most recently
     * closed measured steps, or over every step the session has when it has fewer.
     * Raw sums again — the Client divides, so it can label the actual step count.
     * `null` until one measured step has closed.
     */
    realtime: (() => {
      const totals = ringTotals(recentRing(state));
      return totals === null ? null : { ...totals, window: REALTIME_WINDOW };
    })(),
    // Per-turn rows are not published: nothing consumes them, and keeping them
    // would mean keeping a second running total (see the module note).
    currentTurn: null,
    lastTurn: null,
    totals: { ...state.totals },
  };
  Object.defineProperty(state, VIEW, { value: { rev: state.rev, value }, enumerable: false, configurable: true, writable: true });
  return value;
}

/** A zeroed view of the same shape, used only after a reported failure. */
function fallbackView() {
  return {
    session: {
      ...speedView(emptyCounters()),
      turns: 0,
      averageTtftMs: null,
      averageLlmMs: null,
      unmeasuredInputTokens: 0,
    },
    realtime: null,
    currentTurn: null,
    lastTurn: null,
    totals: { turns: 0, steps: 0, llmMs: 0, toolMs: 0 },
  };
}

/**
 * The `sessionSpeed` unit. Registered by the bundle's Host half and read by its
 * Client half through `useProjection('sessionSpeed')`.
 */
const sessionSpeedProjectionDefinition = {
  key: SPEED_PROJECTION_KEY,
  stateSchema,
  stateVersion: SPEED_PROJECTION_STATE_VERSION,

  init() {
    return emptyState();
  },

  /**
   * Pure and synchronous: events this unit does not model return the SAME state
   * reference, which is what lets the registry skip all downstream work. It never
   * throws; a failure freezes the fold and reports once.
   *
   * @param {any} state
   * @param {any} event
   */
  apply(state, event) {
    try {
      return foldEvent(state, event);
    } catch (error) {
      reportOnce('sessionSpeed fold', error);
      return state;
    }
  },

  wire: {
    viewSchema,
    /**
     * Returns the SAME reference while nothing it shows has changed. Like
     * `apply`, it never throws.
     *
     * @param {any} state
     */
    view(state) {
      try {
        return viewOf(state);
      } catch (error) {
        reportOnce('sessionSpeed view', error);
        return fallbackView();
      }
    },
  },
};

module.exports = {
  SPEED_PROJECTION_KEY,
  SPEED_PROJECTION_STATE_VERSION,
  sessionSpeedProjectionDefinition,
  tokensPerSecond,
};
