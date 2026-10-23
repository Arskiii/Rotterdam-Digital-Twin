/** Resolve assets from the site root, including GitHub Pages repository prefixes. */
export function siteUrl(path: string): URL {
  return new URL(path, new URL(document.documentElement.dataset.root ?? "../", document.baseURI));
}
