import { defineConfig } from "vite";

// `base` must match the GitHub Pages subpath (https://<user>.github.io/<repo>/).
// Override with VITE_BASE=/ for local builds if needed.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/Rotterdam-Digital-Twin/",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
  },
});
