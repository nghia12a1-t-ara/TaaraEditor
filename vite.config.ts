import { defineConfig } from "vite";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022", // WebView2 is Chromium-based
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  worker: { format: "es" },
});
