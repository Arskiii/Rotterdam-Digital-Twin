// Cache registration is best-effort and starts alongside the shared shell.
// ?nosw=1 remains the escape hatch for an already installed broken worker.
import { siteUrl } from "../ui/siteUrl";

export function ownServiceWorkers(registrations: readonly ServiceWorkerRegistration[], scope: string) {
  return registrations.filter((registration) => registration.scope === scope);
}

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const swUrl = siteUrl("sw.js");
  const scope = new URL("./", swUrl);
  try {
    if (new URLSearchParams(location.search).has("nosw")) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(ownServiceWorkers(registrations, scope.href).map((registration) => registration.unregister()));
      try {
        for (const name of await caches.keys()) {
          if (/^rtm-(app|data)-v\d+$/.test(name)) await caches.delete(name);
        }
      } catch { /* Cache Storage can be unavailable in private browsing. */ }
      const url = new URL(location.href);
      url.searchParams.delete("nosw");
      location.replace(url.href);
      return;
    }
    // Development serves unhashed modules, unsuitable for persistent caching.
    if (!import.meta.env.PROD) return;
    await navigator.serviceWorker.register(swUrl.href, { scope: scope.pathname, updateViaCache: "none" });
  } catch { /* Cache support is optional; a valid network load must continue. */ }
}
