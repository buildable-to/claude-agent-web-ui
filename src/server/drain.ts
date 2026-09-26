const DEFAULT_DRAIN_MS = 25 * 60 * 1000;

/** Wait for all foreground and background work, bounded by the deploy deadline.
 *  busy() counts sessions with work; a second signal skips the remaining wait. */
export function createDrainController(options: {
  busy: () => number;
  stop: (reason: string) => void;
  log?: (message: string) => void;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_MS;
  let draining = false;
  let stopped = false;
  let tick: ReturnType<typeof setInterval> | undefined;

  function finish(reason: string) {
    if (stopped) return;
    stopped = true;
    if (tick !== undefined) clearInterval(tick);
    options.stop(reason);
  }

  return {
    get draining() { return draining; },
    signal(signal: 'SIGINT' | 'SIGTERM') {
      if (stopped) return;
      if (draining) {
        finish(`${signal} again: stopping now, ${options.busy()} session(s) with active work cut`);
        return;
      }
      draining = true;
      const n = options.busy();
      if (n === 0) {
        finish(`${signal}: no active work, stopping`);
        return;
      }
      options.log?.(`${signal}: ${n} session(s) with active work, draining (up to ${timeoutMs / 60000} min; no new turns meanwhile)`);
      const started = Date.now();
      tick = setInterval(() => {
        const left = options.busy();
        if (left === 0) {
          finish('drained: no active work, stopping');
        } else if (Date.now() - started >= timeoutMs) {
          finish(`drain timed out: stopping with ${left} session(s) still active`);
        }
      }, 1000);
      tick.unref();
    },
  };
}
