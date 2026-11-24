import { defineConfig } from "vite";
export default defineConfig({
  cacheDir:
    process.env.COMPANION_TRIAL_CACHE ??
    (process.env.COMPANION_QA_GUARDED === "1" && process.env.QA
      ? process.env.QA + "/vite-cache"
      : undefined),
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  build: { target: "es2022" },
});
