import { defineConfig } from "vite";
import { resolve } from "node:path";

// Multi-page setup:
//   /        -> Rotterdam city explorer (also retained at /v03/)
//   /grid/   -> fictional traffic playground
// Dev mode picks up both pages automatically; the rollupOptions below tell the
// production build to emit all three HTMLs.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  build: {
    manifest: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: {
        city: resolve(import.meta.dirname, "index.html"),
        grid: resolve(import.meta.dirname, "grid/index.html"),
        v03: resolve(import.meta.dirname, "v03/index.html"),
        lab: resolve(import.meta.dirname, "lab/index.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
