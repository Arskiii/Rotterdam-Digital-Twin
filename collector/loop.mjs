/** One in-flight run, measured cadence, bounded retry, and an interruptible stop. */
export function startLoop(task, { interval = 120_000, retry = 30_000, now = Date.now, schedule = setTimeout, cancel = clearTimeout, onError = console.error } = {}) {
  let stopped = false, timer, pending;
  const run = () => {
    const started = now();
    let delay = interval;
    pending = Promise.resolve().then(task).catch(error => { delay = retry; onError(error); }).finally(() => {
      if (!stopped) timer = schedule(run, Math.max(1000, delay - (now() - started)));
    });
  };
  run();
  return async () => { stopped = true; cancel(timer); await pending; };
}
