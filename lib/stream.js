/**
 * First-visible-token timing for a durable assistant stream, replicated locally.
 *
 * A plugin may not import another Harness package from its Host half, so this
 * module reimplements exactly the reader the built-in session-statistics fold
 * uses to find a step's first token time — same record shapes, same early-exit
 * order — and records the origin of each rule.
 *
 * Stream records are `AssistantStreamRecord`:
 *   { type: 'text-chunks',      time0, index, dt: number[], texts: string[] }
 *   { type: 'reasoning-chunks', time0, index, dt: number[], texts: string[] }
 *   { type: 'tool-call-chunks', time0, index, dt: number[], id, name?, args: string[] }
 *   { type: 'chunk',            time, chunk: StreamChunk }
 *
 * A packed run stores its members as parallel arrays: the n-th member lands at
 * `time0 + dt[0] + … + dt[n-1]`. Reading only `time0` would report the run's
 * start instead of its first token, which is exactly the error that makes TTFT
 * too small and the speed too high.
 *
 * Every reader is total: a malformed record yields `undefined` rather than
 * throwing, because a throw inside a projection's `apply` would fail the whole
 * fold for that session.
 *
 * @module dsh-prefill-speed-stats/lib/stream
 */

/** Chunk kinds a stream expansion yields for model output. */
const VISIBLE_CHUNK_TYPES = { 'text-delta': true, 'reasoning-delta': true, 'tool-call-delta': true };

/**
 * The time of the n-th member of a packed run: `time0` plus the deltas of the
 * members before it. Mirrors the shipped `runFirstTokenTime` walk, which
 * accumulates `dt` and reports the moment a qualifying member lands.
 *
 * @param {{ time0: number, dt?: readonly number[] }} run
 * @param {number} member
 * @returns {number}
 */
function memberTime(run, member) {
  let time = run.time0;
  const dt = Array.isArray(run.dt) ? run.dt : [];
  for (let i = 0; i < member && i < dt.length; i += 1) time += dt[i];
  return time;
}

/**
 * Expand one packed run into the members a consumer would see, so a reader can
 * test each member for visible content without special-casing the run type.
 *
 * @param {any} run
 * @returns {Array<{ type: string, time: number, text?: string, name?: string }> | undefined}
 */
function expandRun(run) {
  const isTool = run.type === 'tool-call-chunks';
  const fragments = isTool ? run.args : run.texts;
  if (!Array.isArray(fragments)) return undefined;
  const kind = isTool ? 'tool-call-delta' : run.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta';
  const members = [];
  for (let member = 0; member < fragments.length; member += 1) {
    members.push({ type: kind, time: memberTime(run, member), text: fragments[member], name: run.name });
  }
  return members;
}

/** @param {any} record */
function isPackedRun(record) {
  return record.type === 'text-chunks' || record.type === 'reasoning-chunks' || record.type === 'tool-call-chunks';
}

/**
 * Time of a raw single-chunk record when that chunk is a visible delta.
 * Whitespace-only text does not count: a stream that opens with newlines has not
 * produced a token a reader would see.
 *
 * @param {any} record
 * @returns {number | undefined}
 */
function rawChunkTime(record) {
  if (record.type !== 'chunk') return undefined;
  const chunk = record.chunk;
  if (chunk === undefined || chunk === null) return undefined;
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof chunk.text === 'string' && /\S/.test(chunk.text) ? record.time : undefined;
  }
  if (chunk.type === 'tool-call-delta') return record.time;
  return undefined;
}

/**
 * First token time of one packed run, or `undefined` when the run carries no
 * token. A named tool-call run counts from its own start; text and reasoning
 * runs count from their first non-whitespace member.
 *
 * @param {any} run
 * @returns {number | undefined}
 */
function runFirstTokenTime(run) {
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0;
  const members = expandRun(run);
  if (members === undefined) return undefined;
  for (let i = 0; i < members.length; i += 1) {
    const member = members[i];
    if (VISIBLE_CHUNK_TYPES[member.type] !== true) continue;
    if (member.type === 'tool-call-delta') return member.time;
    if (member.text !== undefined && /\S/.test(member.text)) return member.time;
  }
  return undefined;
}

/**
 * First token time over a whole durable stream: the earliest moment the model
 * produced anything a reader would see. `undefined` when the stream produced no
 * visible content at all (an aborted or empty attempt).
 *
 * @param {readonly any[]} stream
 * @returns {number | undefined}
 */
function assistantStreamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined;
  let earliest;
  for (let i = 0; i < stream.length; i += 1) {
    const record = stream[i];
    if (record === null || typeof record !== 'object') continue;
    const time = isPackedRun(record) ? runFirstTokenTime(record) : rawChunkTime(record);
    if (time === undefined) continue;
    if (earliest === undefined || time < earliest) earliest = time;
  }
  return earliest;
}

module.exports = { assistantStreamFirstTokenTime, runFirstTokenTime };
