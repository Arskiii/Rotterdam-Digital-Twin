// Notice when the running tab is out of date.
//
// This is a dashboard people leave open. A tab opened yesterday keeps polling
// live.json and keeps drawing a city, so it looks entirely healthy while
// running whatever JavaScript it loaded at the time — which is how a phone
// ended up showing frozen vehicles and a chip that overflowed its screen for
// hours after both were fixed. Nothing about a stale tab announces itself: the
// data is current, only the code is old.
//
// The check is the cheapest one that is also exact. Vite fingerprints the entry
// bundle, so the filename in the deployed index.html changes on any build that
// changes the code. Compare it with the bundle this page actually loaded.
//
// Reloading is deliberately not immediate. Yanking the page out from under
// someone reading a departure board is worse than being a few minutes old, so
// a visible tab is offered the reload and a hidden one just takes it — coming
// back to a fresh app is the least disruptive moment there is.

const CHECK_MS = 5 * 60_000;

/** The entry bundle this page is running, as an absolute URL. */
function running(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return el ? new URL(el.src, location.href).href : null;
}

/** The entry bundle the server would serve right now. */
async function deployed(): Promise<string | null> {
  try {
    // no-store, not no-cache: an index.html served from the browser's own disk
    // cache would report the build this tab already has and never notice
    const res = await fetch(`${import.meta.env.BASE_URL}index.html`, { cache: "no-store" });
    if (!res.ok) return null;
    const m = (await res.text()).match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
    return m ? new URL(m[1], location.href).href : null;
  } catch {
    return null; // offline, or a host that does not serve index.html by name
  }
}

/**
 * Poll for a newer build and hand it to `onStale` once.
 *
 * Returns without arming if the running bundle cannot be identified — a dev
 * server serves an unhashed entry, where this check would either never fire or
 * fire on every reload.
 */
export function watchForNewBuild(onStale: () => void) {
  const mine = running();
  if (!mine || !/-[A-Za-z0-9_-]{6,}\.js$/.test(mine)) return;
  let fired = false;
  const check = async () => {
    if (fired) return;
    const theirs = await deployed();
    if (!theirs || theirs === mine) return;
    fired = true;
    clearInterval(timer);
    if (document.hidden) location.reload();
    else onStale();
  };
  const timer = setInterval(check, CHECK_MS);
  // A tab coming back after hours is the most likely stale one, and the moment
  // its owner is about to look at it
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check();
  });
  setTimeout(check, 30_000); // one early check, past the boot
}
