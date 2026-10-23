import { TIMEZONE } from "../config";
import { escapeHtml, fmtClockAmPm } from "./format";
import { buildHeader } from "./header";
import { icons } from "./icons";

interface WorkspaceSection {
  id: string;
  label: string;
  icon: keyof typeof icons;
  breakBefore?: boolean;
}

/** The same frame and section navigation for every evidence workspace. */
export function mountWorkspaceChrome({ page, sections }: {
  page: "intelligence" | "lab";
  sections: readonly WorkspaceSection[];
}) {
  document.getElementById("stage")!.insertAdjacentHTML("afterbegin", buildHeader({ page }));
  const sectionLinks = sections.map((section, index) => `${section.breakBefore ? '<div class="rail-sep"></div>' : ""}
    <a class="rail-btn${index === 0 ? " on" : ""}" href="#${escapeHtml(section.id)}" title="${escapeHtml(section.label)}" aria-label="${escapeHtml(section.label)}"${index === 0 ? ' aria-current="location"' : ""}>${icons[section.icon]()}</a>`).join("");
  document.getElementById("rail")!.innerHTML = `
    <a class="rail-btn" href="../" title="Unit map" aria-label="Unit map">${icons.gridDots()}</a>
    <div class="rail-sep"></div>${sectionLinks}
    <div class="rail-space"></div>
    <a class="rail-btn" href="${page === "lab" ? "../v03/" : "../?mode=sim&page=setup"}" title="${page === "lab" ? "Traffic editor" : "Simulation setup"}" aria-label="${page === "lab" ? "Traffic editor" : "Simulation setup"}">${icons.sliders()}</a>`;
  document.querySelectorAll(".workspace-section.brk").forEach((panel) => {
    for (const position of ["tl", "tr", "bl", "br"]) {
      const tick = document.createElement("i");
      tick.className = `tick ${position}`;
      tick.setAttribute("aria-hidden", "true");
      panel.append(tick);
    }
  });

  const content = document.getElementById("content")!;
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".jump a, #rail a[href^='#']")];
  function followScroll() {
    const top = content.getBoundingClientRect().top + document.querySelector(".jump")!.clientHeight + 36;
    let active = sections[0].id;
    for (const { id } of sections) {
      if (document.getElementById(id)!.getBoundingClientRect().top <= top) active = id;
    }
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2) active = sections.at(-1)!.id;
    for (const link of links) {
      const selected = link.hash === `#${active}`;
      link.classList.toggle("on", selected);
      if (selected) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }
  let pending = false;
  content.addEventListener("scroll", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; followScroll(); });
  }, { passive: true });
  // Keep native anchors, focus and history; reveal collapsed report sections.
  const revealSection = () => {
    const id = window.location.hash.slice(1);
    if (!sections.some((section) => section.id === id)) return;
    const section = document.getElementById(id)!;
    if (section instanceof HTMLDetailsElement) section.open = true;
    section.scrollIntoView();
  };
  window.addEventListener("hashchange", () => { revealSection(); followScroll(); });
  requestAnimationFrame(() => { revealSection(); followScroll(); });
  const updateClock = () => { document.getElementById("clock")!.textContent = fmtClockAmPm(new Date(), TIMEZONE); };
  updateClock();
  window.setInterval(updateClock, 60_000);
}
