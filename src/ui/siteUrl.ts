/** Resolve assets from the site root, including GitHub Pages repository prefixes. */
const root = typeof document === "undefined" ? null : new URL(document.documentElement.dataset.root ?? "../", document.baseURI);

export function siteUrl(path: string): URL {
  return new URL(path, root ?? new URL(document.documentElement.dataset.root ?? "../", document.baseURI));
}
