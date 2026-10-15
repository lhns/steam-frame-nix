// request.mjs: relay.mjs's allowlist (only {op:"status"} and
// {op:"set",source:"rgb"|"mono"} may reach the helper), its arguments for
// an allowed request, parsing its one-line JSON reply (or synthesising an
// error one if it crashed, timed out, or printed nothing), and a serial
// queue (the camera interface has no concurrency story of its own). Split
// out from relay.mjs so these pure functions can be imported for testing
// without relay.mjs's own top-level CDP/retry loop running.

export function allowed(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.id !== 'number' && typeof payload.id !== 'string') return false;
  if (payload.op === 'status') return true;
  if (payload.op === 'set') return payload.source === 'rgb' || payload.source === 'mono';
  return false;
}

// Precondition: allowed(payload).
export function argsFor(payload) {
  return payload.op === 'status' ? ['status'] : ['set', payload.source];
}

// The helper's stdout is one JSON object per call ({"ok":true,...} or
// {"ok":false,"error":...}); anything else (a timeout, a crash, no output
// at all) becomes an {"ok":false,"error":...} of our own.
export function parseResult(stdout, error) {
  const text = String(stdout ?? '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through to the synthesised error below */ }
  if (error?.killed) return { ok: false, error: 'the helper timed out' };
  if (error) return { ok: false, error: error.message };
  return { ok: false, error: 'the helper produced no output' };
}

// A queue of (possibly async) jobs run strictly one after another,
// regardless of how they settle; run(job) resolves/rejects with job's own
// outcome once it is its turn.
export function createQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const result = tail.then(job, job);
    tail = result.then(() => {}, () => {});
    return result;
  };
}
