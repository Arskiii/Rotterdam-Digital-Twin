import "./platform.css";

/** Resolve assets from the site root, including GitHub Pages repository prefixes. */
export function siteUrl(path: string): URL {
  return new URL(path, new URL(document.documentElement.dataset.root ?? "../", document.baseURI));
}

export function installNavigation(current: "map" | "lab" | "grid") {
  const header = document.createElement("header");
  header.className = "platform-header";
  const brand = document.createElement("a");
  brand.className = "platform-brand";
  brand.href = siteUrl("").href;
  brand.textContent = "ROTTERDAM";
  const subtitle = document.createElement("span");
  subtitle.textContent = "DIGITAL TWIN";
  brand.append(subtitle);
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Main navigation");
  for (const [key, label, path] of [["map", "City explorer", ""], ["lab", "Scenario lab", "lab/"], ["grid", "Playground", "grid/"]] as const) {
    const link = document.createElement("a");
    link.href = siteUrl(path).href;
    link.textContent = label;
    if (current === key) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  const badge = document.createElement("span");
  badge.className = "platform-badge";
  badge.textContent = "Research preview";
  header.append(brand, nav, badge);
  document.body.prepend(header);
}
