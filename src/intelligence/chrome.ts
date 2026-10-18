import { TIMEZONE } from "../config";
import { fmtClockAmPm } from "../ui/format";
import { icons } from "../ui/icons";
import { buildHeader } from "../ui/header";
import type { LiveFeed } from "../data/live";

const sections = ["sources", "scenario", "neighborhoods", "proof", "api"] as const;

export function mountIntelligenceChrome() {
  document.getElementById("stage")!.insertAdjacentHTML("afterbegin", buildHeader({ page: "intelligence", mapHref: "../" }));
  document.getElementById("rail")!.innerHTML = `
    <a class="rail-btn" href="../" title="Unit map" aria-label="Unit map">${icons.gridDots()}</a>
    <div class="rail-sep"></div>
    <a class="rail-btn on" href="#sources" title="Observation quality" aria-label="Observation quality" aria-current="location">${icons.shield()}</a>
    <a class="rail-btn" href="#scenario" title="Rain and bridge scenario" aria-label="Rain and bridge scenario">${icons.layers()}</a>
    <a class="rail-btn" href="#neighborhoods" title="Neighborhood context" aria-label="Neighborhood context">${icons.people()}</a>
    <a class="rail-btn" href="#proof" title="Model checks" aria-label="Model checks">${icons.target()}</a>
    <div class="rail-sep"></div>
    <a class="rail-btn" href="#api" title="Open data" aria-label="Open data">${icons.lock()}</a>
    <div class="rail-space"></div>
    <a class="rail-btn" href="../?mode=sim&page=setup" title="Simulation setup" aria-label="Simulation setup">${icons.sliders()}</a>`;
  document.querySelectorAll(".intel-section").forEach((panel) => {
    for (const position of ["tl", "tr", "bl", "br"]) {
      const tick = document.createElement("i");
      tick.className = `tick ${position}`;
      tick.setAttribute("aria-hidden", "true");
      panel.append(tick);
    }
  });

  const content = document.getElementById("content")!;
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".jump a, #rail a[href^='#']")];
  function selectSection(id: string) {
    for (const link of links) {
      const active = link.hash === `#${id}`;
      link.classList.toggle("on", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }
  let pending = false;
  function followScroll() {
    pending = false;
    const top = content.getBoundingClientRect().top + document.querySelector(".jump")!.clientHeight + 36;
    let active: string = sections[0];
    for (const id of sections) {
      if (document.getElementById(id)!.getBoundingClientRect().top <= top) active = id;
    }
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2) active = sections.at(-1)!;
    selectSection(active);
  }
  content.addEventListener("scroll", () => {
    if (!pending) { pending = true; requestAnimationFrame(followScroll); }
  }, { passive: true });
  // Native anchors preserve keyboard navigation and browser history.
  requestAnimationFrame(() => {
    const id = window.location.hash.slice(1);
    if (sections.some((section) => section === id)) document.getElementById(id)!.scrollIntoView();
    followScroll();
  });
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
