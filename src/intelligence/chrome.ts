import { TIMEZONE } from "../config";
import { fmtClockAmPm } from "../ui/format";
import { mountWorkspaceChrome } from "../ui/workspace";
import type { LiveFeed } from "../data/live";

export function mountIntelligenceChrome() {
  mountWorkspaceChrome({ page: "intelligence", sections: [
    { id: "sources", label: "Observation quality", icon: "shield" },
    { id: "scenario", label: "Rain and bridge scenario", icon: "layers" },
    { id: "neighborhoods", label: "Neighborhood context", icon: "people" },
    { id: "proof", label: "Model checks", icon: "target" },
    { id: "api", label: "Open data", icon: "lock", breakBefore: true },
  ] });
}

export function updateIntelligenceHeader(feed: LiveFeed) {
  const chip = document.getElementById("live-chip")!;
  const age = feed.ageMin();
  const health = feed.health();
  const label = health === "offline" ? "FEED OFFLINE" : `${health === "live" ? "LIVE" : health === "lagging" ? "FEED LAGGING" : "FEED STALE"} — ${Math.round(age)}M OLD`;
  chip.style.display = "flex";
  chip.title = label;
  document.getElementById("live-text")!.textContent = label;
  document.getElementById("live-dot")!.style.background = health === "live" ? "var(--green)" : health === "lagging" ? "var(--amber)" : health === "offline" ? "var(--gray-dot)" : "var(--red)";
  document.getElementById("clock")!.textContent = fmtClockAmPm(new Date(), TIMEZONE);
}
