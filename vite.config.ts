import { defineConfig } from "vite";

// Relative base ("./") makes asset URLs work no matter the repo-name casing
// or subpath GitHub Pages serves us under. Override with VITE_BASE=/ if you
// ever host this at the domain root.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
  },
});
