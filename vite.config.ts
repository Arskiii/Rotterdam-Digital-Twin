import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Relative base ("./") makes asset URLs work no matter the repo-name casing
// or subpath GitHub Pages serves us under. Override with VITE_BASE=/ if you
// ever host this at the domain root.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        intelligence: fileURLToPath(new URL("./intelligence/index.html", import.meta.url)),
      },
    },
  },
  server: {
    host: true,
    // honor the harness-assigned port (autoPort) but default to 5173
    port: Number(process.env.PORT ?? 5173),
  },
});
