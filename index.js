/**
 * Host half of `dsh-prefill-speed-stats`.
 *
 * Registers the `sessionSpeed` session projection, which publishes the prompt
 * token counters and step timings the Client's prefill-speed strip reads. The
 * browser half is attached by `dsh-client-modules` to this same Loader row (a
 * package's `dsh.client` declaration is served from its `./client` export), so
 * there is no second row to insert.
 *
 * The registration is guarded on purpose. This plugin rides the application's
 * boot path: a throw here fails this entry's activation, and the deployment's
 * boot audit treats a single failed activation as a refused startup — the user
 * loses the whole application, not one strip. Every failure below therefore
 * degrades to "this plugin contributes nothing" and reports once.
 *
 * @module dsh-prefill-speed-stats
 */

const { sessionSpeedProjectionDefinition } = require('./lib/projection.js');

const name = 'prefill-speed-stats';

/** One console warning per label per process. */
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

/**
 * Register the projection.
 *
 * `sessionProjections` is resolved through `ctx.inject` rather than read off the
 * context, so the plugin waits for the service instead of requiring a load order.
 *
 * @param {any} ctx
 */
function apply(ctx) {
  try {
    ctx.inject(['sessionProjections'], (scope) => {
      try {
        scope.sessionProjections.register(sessionSpeedProjectionDefinition);
      } catch (error) {
        reportOnce('projection registration', error);
      }
    });
  } catch (error) {
    reportOnce('service injection', error);
  }
}

module.exports = { name, apply };
