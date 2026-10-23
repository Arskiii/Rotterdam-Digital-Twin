import { escapeHtml } from "./format";
import { icons } from "./icons";
import { siteUrl } from "./siteUrl";

interface WorkspaceSection {
  id: string;
  label: string;
  icon: keyof typeof icons;
  breakBefore?: boolean;
}

/** Add section tools inside the existing app shell, once per persistent view. */
export function mountWorkspaceChrome({ page, sections, root }: {
  page: "intelligence" | "lab";
  sections: readonly WorkspaceSection[];
  root: HTMLElement;
}) {
  const rail = document.createElement("div");
  rail.className = "rail-view";
  rail.dataset.workspaceRail = page;
  rail.hidden = root.hidden;
  const sectionLinks = sections.map((section, index) => `${section.breakBefore ? '<div class="rail-sep"></div>' : ""}
    <a class="rail-btn${index === 0 ? " on" : ""}" href="#${escapeHtml(section.id)}" title="${escapeHtml(section.label)}" aria-label="${escapeHtml(section.label)}"${index === 0 ? ' aria-current="location"' : ""}>${icons[section.icon]()}</a>`).join("");
  rail.innerHTML = `
    <a class="rail-btn" href="${escapeHtml(siteUrl("?page=map").href)}" title="Unit map" aria-label="Unit map">${icons.gridDots()}</a>
    <div class="rail-sep"></div>${sectionLinks}
    <div class="rail-space"></div>
    <a class="rail-btn" href="${escapeHtml(siteUrl(page === "lab" ? "v03/" : "?mode=sim&page=setup").href)}" title="${page === "lab" ? "Traffic editor" : "Simulation setup"}" aria-label="${page === "lab" ? "Traffic editor" : "Simulation setup"}">${icons.sliders()}</a>`;
  document.getElementById("rail")!.append(rail);
  root.querySelectorAll(".workspace-section.brk").forEach((panel) => {
    for (const position of ["tl", "tr", "bl", "br"]) {
      const tick = document.createElement("i");
      tick.className = `tick ${position}`;
      tick.setAttribute("aria-hidden", "true");
      panel.append(tick);
    }
  });

  const content = root.querySelector<HTMLElement>(".workspace-content")!;
  const links = [...root.querySelectorAll<HTMLAnchorElement>(".jump a"), ...rail.querySelectorAll<HTMLAnchorElement>("a[href^='#']")];
  function followScroll() {
    if (root.hidden) return;
    const top = content.getBoundingClientRect().top + root.querySelector(".jump")!.clientHeight + 36;
    let active = sections[0].id;
    for (const { id } of sections) {
      if (root.querySelector(`#${id}`)!.getBoundingClientRect().top <= top) active = id;
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
  const revealSection = () => {
    if (root.hidden) return;
    const id = window.location.hash.slice(1);
    if (sections.some((section) => section.id === id)) {
      const section = root.querySelector(`#${id}`)!;
      if (section instanceof HTMLDetailsElement) section.open = true;
      section.scrollIntoView();
    }
    followScroll();
  };
  root.addEventListener("viewchange", () => requestAnimationFrame(revealSection));
  requestAnimationFrame(revealSection);
}
