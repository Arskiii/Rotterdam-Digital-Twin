import { afterEach, describe, expect, it, vi } from "vitest";
import { ownServiceWorkers, registerServiceWorker } from "./sw-register";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("offline cache registration", () => {
  it("only unregisters the application's exact scope", () => {
    const own = { scope: "https://example.test/twin/" } as ServiceWorkerRegistration;
    const other = { scope: "https://example.test/other/" } as ServiceWorkerRegistration;
    const parent = { scope: "https://example.test/" } as ServiceWorkerRegistration;
    expect(ownServiceWorkers([other, own, parent], own.scope)).toEqual([own]);
  });

  it("registers from the site root, including repository-prefixed deep links", async () => {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("document", { documentElement: { dataset: { root: "../" } }, baseURI: "https://example.test/twin/lab/" });
    vi.stubGlobal("location", new URL("https://example.test/twin/lab/"));
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    await registerServiceWorker();
    expect(register).toHaveBeenCalledWith("https://example.test/twin/sw.js", { scope: "/twin/", updateViaCache: "none" });
  });

  it("a blocked service worker does not reject application startup", async () => {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("document", { documentElement: { dataset: { root: "./" } }, baseURI: "https://example.test/twin/" });
    vi.stubGlobal("location", new URL("https://example.test/twin/"));
    vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn().mockRejectedValue(new Error("Denied")) } });
    await expect(registerServiceWorker()).resolves.toBeUndefined();
  });
});
