import { afterEach, expect, it, vi } from "vitest";
import { watchForNewBuild } from "./buildwatch";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("offers a newer build once without reloading a hidden workspace, and cleans up its checks", async () => {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { hidden: true, querySelector: () => ({ src: "https://city.test/assets/main-abcdefgh.js" }) });
  const reload = vi.fn();
  vi.stubGlobal("document", doc); vi.stubGlobal("location", { href: "https://city.test/", reload });
  const fetcher = vi.fn(async () => new Response('<script type="module" src="/assets/main-ijklmnop.js"></script>'));
  vi.stubGlobal("fetch", fetcher);
  const offer = vi.fn(), stop = watchForNewBuild(offer);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(offer).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
  doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(600_000);
  expect(fetcher).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
  stop(); expect(vi.getTimerCount()).toBe(0);
});
