import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Relative base ("./") makes asset URLs work no matter the repo-name casing
// or subpath GitHub Pages serves us under. Override with VITE_BASE=/ if you
// ever host this at the domain root.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  build: {
    manifest: true,
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        intelligence: fileURLToPath(new URL("./intelligence/index.html", import.meta.url)),
        lab: fileURLToPath(new URL("./lab/index.html", import.meta.url)),
        grid: fileURLToPath(new URL("./grid/index.html", import.meta.url)),
        v03: fileURLToPath(new URL("./v03/index.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    // honor the harness-assigned port (autoPort) but default to 5173
    port: Number(process.env.PORT ?? 5173),
  },
});
