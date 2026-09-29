/**
 * Checks for the `sessionSpeed` fold and the two prefill-speed algorithms.
 *
 * Run with the deployment's Node (this package has no build step):
 *
 *   node --test dsh-prefill-speed-stats/test/
 *
 * The fixtures are shaped exactly like durable `SessionEvent`s, including the
 * packed `AssistantStreamRecord` runs, so the assertions cover what is easiest to
 * get wrong: TTFT from a non-whitespace member, the decode window closing on
 * `assistant/message`, the turn counter, the prompt-token convention, retries
 * inside one step, a step that never closes, the measured-only rule, the last-N
 * window, and a state written before a field existed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { sessionSpeedProjectionDefinition: unit, tokensPerSecond } = require('../lib/projection.js');

/** @param {string} type @param {number} time @param {any} data */
function event(type, time, data) {
  return { type, time, data, seq: time };
}

/** A packed text run whose members land `dt` after the run starts. */
function textRun(time0, texts, dt) {
  return { type: 'text-chunks', time0, index: 0, dt: dt === undefined ? texts.map(() => 10) : dt, texts };
}

function fold(events) {
  let state = unit.init();
  for (const item of events) state = unit.apply(state, item);
  return unit.wire.view(state);
}

function turnStart(turn, time) {
  return event('turn/start', time === undefined ? 0 : time, { turn });
}

/**
 * One completed step: `step/start` -> `assistant/message` -> `step/end`.
 *
 * `uncached` is the provider's `usage.inputTokens`, i.e. the part of the prompt
 * it had to read; the cache buckets are added on top of it.
 */
function completedStep(options) {
  const o = options || {};
  const start = o.start === undefined ? 0 : o.start;
  const firstToken = o.firstToken === undefined ? 100 : o.firstToken;
  const end = o.end === undefined ? 1100 : o.end;
  const turn = o.turn === undefined ? 1 : o.turn;
  const step = o.step === undefined ? 1 : o.step;
  return [
    event('step/start', start, { turn, step }),
    event('assistant/message', end, {
      turn,
      step,
      message: { role: 'assistant', content: [] },
      stream: [textRun(firstToken, ['hello', 'there'])],
      usage: {
        inputTokens: o.uncached === undefined ? 2000 : o.uncached,
        outputTokens: o.output === undefined ? 400 : o.output,
        cacheReadTokens: o.cacheRead === undefined ? 6000 : o.cacheRead,
        cacheWriteTokens: o.cacheWrite === undefined ? 0 : o.cacheWrite,
      },
    }),
    event('step/end', end, { turn, step }),
  ];
}

/**
 * `count` completed steps in one turn, each reading `uncached` tokens with a
 * 100ms first-token latency, spaced `stride` apart.
 */
function stepSeries(count, options) {
  const o = options || {};
  const stride = o.stride === undefined ? 1000 : o.stride;
  const uncached = o.uncached === undefined ? 2000 : o.uncached;
  const cacheRead = o.cacheRead === undefined ? 0 : o.cacheRead;
  const events = [];
  for (let index = 0; index < count; index += 1) {
    events.push(
      ...completedStep({
        turn: 1,
        step: index + 1,
        start: index * stride,
        firstToken: index * stride + 100,
        end: index * stride + stride,
        uncached,
        cacheRead,
      }),
    );
  }
  return events;
}

/**
 * A step that produced a message but never closed: no `step/end` follows, which
 * is what an interrupted turn leaves in the log.
 */
function openStep(options) {
  const o = options || {};
  const start = o.start === undefined ? 0 : o.start;
  const firstToken = o.firstToken === undefined ? 100 : o.firstToken;
  const end = o.end === undefined ? 1100 : o.end;
  const turn = o.turn === undefined ? 1 : o.turn;
  const step = o.step === undefined ? 1 : o.step;
  return [
    event('step/start', start, { turn, step }),
    event('assistant/message', end, {
      turn,
      step,
      message: { role: 'assistant', content: [] },
      stream: [textRun(firstToken, ['partial'])],
      usage: {
        inputTokens: o.uncached === undefined ? 500 : o.uncached,
        outputTokens: o.output === undefined ? 50 : o.output,
        cacheReadTokens: o.cacheRead === undefined ? 0 : o.cacheRead,
      },
    }),
  ];
}

test('measures input and output speed from one completed step', () => {
  const view = fold([turnStart(1, 0)].concat(completedStep()));

  // prompt = 2000 uncached + 6000 cache read + 0 cache write = 8000, over a 100ms TTFT
  assert.equal(view.session.inputTokens, 8000);
  assert.equal(view.session.uncachedInputTokens, 2000);
  assert.equal(view.session.cachedInputTokens, 6000);
  assert.equal(view.session.input, 80000);
  assert.equal(view.session.inputUncached, 20000);
  // decode: 400 output tokens over 1000ms
  assert.equal(view.session.output, 400);
  assert.equal(view.session.ttftMs, 100);
  assert.equal(view.session.decodeMs, 1000);
  assert.equal(view.session.steps, 1);
  assert.equal(view.totals.steps, 1);
  assert.equal(view.totals.turns, 1);
  assert.equal(view.totals.llmMs, 1100);
  // one step in, the last-N window is that step
  assert.equal(view.realtime.steps, 1);
  assert.equal(view.realtime.uncachedInputTokens, 2000);
});

test('counts cache writes into the prompt', () => {
  const view = fold([turnStart(1, 0)].concat(completedStep({ uncached: 1000, cacheRead: 0, cacheWrite: 500 })));
  assert.equal(view.session.inputTokens, 1500);
  assert.equal(view.session.cachedInputTokens, 500);
});

test('accumulates a multi-step turn into the session sums, once each', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(completedStep({ start: 0, firstToken: 100, end: 1000, step: 1 }))
      .concat(completedStep({ start: 1000, firstToken: 1100, end: 2100, step: 2, uncached: 9000, cacheRead: 0, output: 600 }))
      .concat([event('turn/end', 2100, { turn: 1, reason: { kind: 'completed' } })]),
  );

  // each step is counted once: the published sums are the accumulator plus the open
  // measured step, never the accumulator plus a second set of the same steps
  assert.equal(view.session.steps, 2);
  assert.equal(view.session.inputTokens, 17000);
  assert.equal(view.session.uncachedInputTokens, 11000);
  assert.equal(view.session.ttftMs, 200);
  assert.equal(view.session.decodeMs, 1900);
  assert.equal(view.session.outputTokens, 1000);
  assert.equal(view.session.input, 85000);
  assert.ok(Math.abs(view.session.output - 1000 / 1.9) < 1e-9);
  assert.equal(view.totals.steps, 2);
  assert.equal(view.totals.turns, 1);
});

test('counts one turn per turn, not one per step', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(stepSeries(3))
      .concat([event('turn/end', 3000, { turn: 1, reason: { kind: 'completed' } })])
      .concat([turnStart(2, 3000)])
      .concat(completedStep({ turn: 2, step: 1, start: 3000, firstToken: 3100, end: 4000, uncached: 100, cacheRead: 0 }))
      .concat([event('turn/end', 4000, { turn: 2, reason: { kind: 'completed' } })]),
  );

  assert.equal(view.totals.steps, 4);
  assert.equal(view.totals.turns, 2);
  assert.equal(view.session.steps, 4);
});

test('a step with no first token is not a prefill sample', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat([
        event('step/start', 0, { turn: 1, step: 1 }),
        event('assistant/message', 500, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [] },
          stream: [],
          usage: { inputTokens: 4000, outputTokens: 10 },
        }),
        event('step/end', 500, { turn: 1, step: 1 }),
      ]),
  );

  // No window exists, so the step contributes to no rate: not its tokens, and not
  // its elapsed time either, because that time cannot be split into prefill and
  // decode. Counting one without the other would bias the figure.
  assert.equal(view.session.input, null);
  assert.equal(view.session.output, null);
  assert.equal(view.session.ttftMs, 0);
  assert.equal(view.session.steps, 0);
  assert.equal(view.session.uncachedInputTokens, 0);
  assert.equal(view.session.inputTokens, 0);
  // what it did read stays visible instead of being silently dropped
  assert.equal(view.session.unmeasuredInputTokens, 4000);
  assert.equal(view.realtime, null);
  // the step itself still happened
  assert.equal(view.totals.steps, 1);
});

test('the session average and the last-N window reject the same steps', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(completedStep({ turn: 1, step: 1, uncached: 2000, cacheRead: 0 }))
      .concat([
        // an aborted step in the middle: it must move neither algorithm's totals
        event('step/start', 2000, { turn: 1, step: 2 }),
        event('assistant/message', 2600, {
          turn: 1,
          step: 2,
          message: { role: 'assistant', content: [] },
          stream: [],
          usage: { inputTokens: 7000, outputTokens: 5 },
        }),
        event('step/end', 2600, { turn: 1, step: 2 }),
      ])
      .concat(completedStep({ turn: 1, step: 3, start: 3000, firstToken: 3200, end: 4000, uncached: 1000, cacheRead: 0 })),
  );

  // one session, one rule: both algorithms divide the same kind of sums, so with
  // fewer steps than the window they must agree exactly
  assert.equal(view.session.steps, 2);
  assert.equal(view.session.uncachedInputTokens, 3000);
  assert.equal(view.session.ttftMs, 300);
  assert.equal(view.realtime.steps, 2);
  assert.equal(view.realtime.uncachedInputTokens, view.session.uncachedInputTokens);
  assert.equal(view.realtime.ttftMs, view.session.ttftMs);
  assert.equal(view.session.unmeasuredInputTokens, 7000);
});

test('whitespace-only deltas do not count as the first token', () => {
  const view = fold([
    turnStart(1, 0),
    event('step/start', 0, { turn: 1, step: 1 }),
    event('assistant/message', 900, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      // the first member is whitespace, so the 200ms member is the first token
      stream: [textRun(100, ['\n\n', 'real'], [100, 100])],
      usage: { inputTokens: 1000, outputTokens: 50 },
    }),
    event('step/end', 900, { turn: 1, step: 1 }),
  ]);

  assert.equal(view.session.ttftMs, 200);
  assert.equal(view.session.decodeMs, 700);
});

test('an earlier attempt latches the step first-token time', () => {
  const view = fold([
    turnStart(1, 0),
    event('step/start', 0, { turn: 1, step: 1 }),
    event('assistant/attempt', 100, { turn: 1, step: 1, stream: [textRun(100, ['a'])] }),
    event('assistant/attempt', 300, { turn: 1, step: 1, stream: [textRun(300, ['b'])] }),
    event('assistant/message', 800, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [textRun(300, ['b'])],
      usage: { inputTokens: 2000, outputTokens: 100 },
    }),
    event('step/end', 800, { turn: 1, step: 1 }),
  ]);

  assert.equal(view.session.ttftMs, 100);
  assert.equal(view.session.decodeMs, 700);
  assert.equal(view.session.inputTokens, 2000);
});

test('a retry message for a settled step is ignored, like the built-in fold', () => {
  const view = fold([
    turnStart(1, 0),
    event('step/start', 0, { turn: 1, step: 1 }),
    event('assistant/message', 1000, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [textRun(100, ['first'])],
      usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0 },
    }),
    // the retry re-announces the same step: it must change NOTHING, because adding
    // its tokens while the window stays the first message's would put the numerator
    // and the denominator on different time spans
    event('assistant/message', 2000, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [textRun(150, ['second'])],
      usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 },
    }),
    event('step/end', 2000, { turn: 1, step: 1 }),
  ]);

  assert.equal(view.session.inputTokens, 2000);
  assert.equal(view.session.uncachedInputTokens, 2000);
  assert.equal(view.session.outputTokens, 400);
  // the model window closed on the FIRST message
  assert.equal(view.totals.llmMs, 1000);
  // and so did TTFT and the decode window
  assert.equal(view.session.ttftMs, 100);
  assert.equal(view.session.decodeMs, 900);
  assert.equal(view.session.steps, 1);
});

test('an attempt after the message settles cannot rewrite the first token', () => {
  const view = fold([
    turnStart(1, 0),
    event('step/start', 0, { turn: 1, step: 1 }),
    event('assistant/message', 1000, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [textRun(100, ['done'])],
      usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0 },
    }),
    // a late attempt carrying a LATER first token must not shorten the window
    event('assistant/attempt', 1500, { turn: 1, step: 1, stream: [textRun(900, ['late'])] }),
    event('step/end', 1600, { turn: 1, step: 1 }),
  ]);

  assert.equal(view.session.ttftMs, 100);
  assert.equal(view.session.uncachedInputTokens, 2000);
});

test('a step with no assistant message counts once and keeps no model time', () => {
  const view = fold([turnStart(1, 0), event('step/start', 0, { turn: 1, step: 1 }), event('step/end', 400, { turn: 1, step: 1 })]);

  assert.equal(view.totals.steps, 1);
  assert.equal(view.session.steps, 0);
  assert.equal(view.session.inputTokens, 0);
  assert.equal(view.session.input, null);
  // llm time closes on assistant/message, so a step without one has none
  assert.equal(view.totals.llmMs, 0);
});

test('a step that never closes has its tokens pooled, not dropped', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(openStep({ turn: 1, step: 1, start: 0, firstToken: 100, end: 1000, uncached: 300, output: 30 }))
      .concat([event('turn/end', 1000, { turn: 1, reason: { kind: 'completed' } })]),
  );

  // A settled step that never closed enters no rate — the built-in fold counts
  // steps on `step/end` — so its tokens are pooled in `unmeasuredInputTokens`
  // rather than dropped.
  assert.equal(view.session.steps, 0);
  assert.equal(view.session.inputTokens, 0);
  assert.equal(view.session.unmeasuredInputTokens, 300);
  assert.equal(view.realtime, null);
  // the model time it spent is still accounted for
  assert.equal(view.totals.llmMs, 1000);
});

test('an interrupted turn keeps the model time it already spent', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(openStep({ turn: 1, step: 1, start: 0, firstToken: 100, end: 1000 }))
      .concat([event('turn/end', 1000, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })]),
  );

  assert.equal(view.totals.llmMs, 1000);
});

test('re-announcing the collecting turn does not wipe it', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(completedStep({ turn: 1, step: 1 }))
      .concat([turnStart(1, 1100)])
      .concat(completedStep({ turn: 1, step: 2, start: 1100, firstToken: 1200, end: 2200, uncached: 100, cacheRead: 0, output: 10 }))
      .concat([event('turn/end', 2200, { turn: 1, reason: { kind: 'completed' } })]),
  );

  assert.equal(view.totals.turns, 1);
  assert.equal(view.totals.steps, 2);
  assert.equal(view.session.steps, 2);
  assert.equal(view.session.inputTokens, 8100);
});

test('an abandoned open step does not corrupt the sums', () => {
  const view = fold([
    turnStart(1, 0),
    // a step measures a window and is settled, but its `step/end` never arrives
    event('step/start', 0, { turn: 1, step: 1 }),
    event('assistant/message', 1000, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [textRun(100, ['partial'])],
      usage: { inputTokens: 700, outputTokens: 70, cacheReadTokens: 0 },
    }),
    // the next step replaces the boundary
    event('step/start', 1200, { turn: 1, step: 2 }),
  ]);

  // Only the replacement boundary is open, and it carries no measurement: the
  // session row stays empty, the last-N window is null, and the unmeasured pool
  // stays at zero.
  assert.equal(view.session.steps, 0);
  assert.equal(view.realtime, null);
  assert.equal(view.session.unmeasuredInputTokens, 0);
});

test('tool wall time is matched call to result', () => {
  const view = fold([
    turnStart(1, 0),
    event('step/start', 0, { turn: 1, step: 1 }),
    event('tool/call', 100, { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' }),
    event('tool/result', 350, {
      turn: 1,
      step: 1,
      message: { role: 'tool', content: [], toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' } },
    }),
    event('step/end', 400, { turn: 1, step: 1 }),
  ]);

  assert.equal(view.totals.toolMs, 250);
});

// --- the last-N window -----------------------------------------------------

test('the last-N window is empty until one measured step closes', () => {
  const view = fold([turnStart(1, 0), event('step/start', 0, { turn: 1, step: 1 })]);
  assert.equal(view.realtime, null);
});

test('the last-N window uses the steps a short session has', () => {
  const view = fold([turnStart(1, 0)].concat(stepSeries(3)));
  // three steps, 2000 uncached each over 100ms each
  assert.equal(view.realtime.steps, 3);
  assert.equal(view.realtime.window, 10);
  assert.equal(view.realtime.uncachedInputTokens, 6000);
  assert.equal(view.realtime.ttftMs, 300);
  // with fewer steps than the window both algorithms see the same set
  assert.equal(view.session.uncachedInputTokens, 6000);
  assert.equal(view.realtime.uncachedInputTokens, view.session.uncachedInputTokens);
});

test('the last-N window is the most recent ten steps, not the whole session', () => {
  // 14 steps: the first four must fall out of the window
  const view = fold([turnStart(1, 0)].concat(stepSeries(14)));

  assert.equal(view.session.steps, 14);
  assert.equal(view.realtime.steps, 10);
  assert.equal(view.realtime.window, 10);
  assert.equal(view.realtime.uncachedInputTokens, 10 * 2000);
  assert.equal(view.realtime.ttftMs, 10 * 100);
  // the session keeps every step, so the two algorithms disagree by design
  assert.equal(view.session.uncachedInputTokens, 14 * 2000);
  assert.equal(view.session.ttftMs, 14 * 100);
});

test('a step without a first token stays out of the last-N window', () => {
  const view = fold(
    []
      .concat([turnStart(1, 0)])
      .concat(stepSeries(2))
      .concat([
        // an aborted step: it read a prompt, but there is no window to divide by,
        // so it must not enter either algorithm's sums
        event('step/start', 2000, { turn: 1, step: 3 }),
        event('assistant/message', 2500, {
          turn: 1,
          step: 3,
          message: { role: 'assistant', content: [] },
          stream: [],
          usage: { inputTokens: 9999, outputTokens: 1 },
        }),
        event('step/end', 2500, { turn: 1, step: 3 }),
      ]),
  );

  assert.equal(view.session.steps, 2);
  assert.equal(view.session.uncachedInputTokens, 2 * 2000);
  assert.equal(view.session.unmeasuredInputTokens, 9999);
  assert.equal(view.realtime.steps, 2);
  assert.equal(view.realtime.uncachedInputTokens, 2 * 2000);
  assert.equal(view.realtime.ttftMs, 200);
});

test('a state written before the measure ring existed still folds and reads', () => {
  // A persisted state written before the ring field existed carries no `recent`
  // array; folding into it and reading it must both stay total.
  let state = unit.apply(unit.init(), turnStart(1, 0));
  delete state.recent;
  unit.stateSchema.parse(state);

  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[0]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[1]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[2]);
  const view = unit.wire.view(state);

  assert.equal(view.session.steps, 1);
  assert.equal(view.realtime.steps, 1);
});

test('a damaged measure ring costs a reading, not the session', () => {
  let state = unit.apply(unit.init(), turnStart(1, 0));
  state = { ...state, recent: 'not an array' };
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[0]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[1]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[2]);

  const view = unit.wire.view(state);
  assert.equal(view.session.steps, 1);
  assert.equal(view.realtime.steps, 1);
});

test('a state written before the unmeasured pool exists still folds and reads', () => {
  // A persisted state that predates a field must cost a reading at most, never the
  // session: the pool accessor reads a missing field as zero.
  let state = unit.apply(unit.init(), turnStart(1, 0));
  delete state.unmeasuredInputTokens;
  unit.stateSchema.parse(state);

  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[0]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[1]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[2]);
  const view = unit.wire.view(state);

  assert.equal(view.session.steps, 1);
  assert.equal(view.session.unmeasuredInputTokens, 0);
});

test('a state written before the turn identity existed still folds and reads', () => {
  let state = unit.apply(unit.init(), turnStart(1, 0));
  delete state.closedTurn;
  unit.stateSchema.parse(state);

  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[0]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[1]);
  state = unit.apply(state, completedStep({ turn: 1, step: 1 })[2]);
  const view = unit.wire.view(state);

  assert.equal(view.session.steps, 1);
  assert.equal(view.totals.turns, 1);
});

test('events this unit does not model keep the state reference', () => {
  const state = unit.init();
  const untouched = unit.apply(state, event('request/header', 5, { header: {}, reason: 'initial' }));
  assert.equal(untouched, state, 'an unmodelled event returns the same state reference');
  assert.equal(unit.apply(state, event('llm/retry', 6, {})), state);

  const first = unit.wire.view(untouched);
  assert.equal(unit.wire.view(untouched), first, 'an unchanged state yields the same view reference');
});

test('the folded state passes its own schema and stays plain JSON', () => {
  let state = unit.init();
  const events = []
    .concat([turnStart(1, 0)])
    .concat(completedStep({}))
    .concat([event('turn/end', 1100, { turn: 1, reason: { kind: 'completed' } })]);
  for (const item of events) state = unit.apply(state, item);
  unit.stateSchema.parse(state);
  unit.wire.viewSchema.parse(unit.wire.view(state));

  const plain = JSON.parse(JSON.stringify(state));
  assert.equal(plain.turn.steps, 1);
  assert.equal(plain.turn.inputTokens, 8000);
  assert.equal(plain.recent.length, 1);
  assert.equal(plain.closedTurn, 1);
});

test('the stream reader tolerates malformed records', () => {
  const { assistantStreamFirstTokenTime } = require('../lib/stream.js');
  assert.equal(assistantStreamFirstTokenTime([]), undefined);
  assert.equal(assistantStreamFirstTokenTime(undefined), undefined);
  assert.equal(assistantStreamFirstTokenTime([null, 42, {}]), undefined);
  assert.equal(assistantStreamFirstTokenTime([{ type: 'text-chunks', time0: 5 }]), undefined);
});

test('tokensPerSecond reports unmeasured rather than zero', () => {
  assert.equal(tokensPerSecond(100, 0), null);
  assert.equal(tokensPerSecond(0, 100), 0);
  assert.equal(tokensPerSecond(1000, 1000), 1000);
});
