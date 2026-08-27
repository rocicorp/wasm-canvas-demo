import { createRequire } from "node:module";

import { defineConfig } from "vite";

// The prebuilt wasm engine binary, out of the published `@rindle/wasm` (its exports map opens
// `./pkg/*`). Aliased so the app can `import url from "rindle-wasm-bin?url"` and hand the URL to
// `initWasm`, rather than relying on the pkg wrapper's own
// `new URL("rindle_bg.wasm", import.meta.url)` guess.
const wasmBin = createRequire(import.meta.url).resolve("@rindle/wasm/pkg/rindle_bg.wasm");

export default defineConfig({
  // The demo generates its base in a worker and posts it across as transferable buffers; es2022 is
  // what the engine's other apps target.
  build: { target: "es2022" },
  resolve: {
    // Regex find so the `?url` suffix survives the rewrite in both dev and build.
    alias: [{ find: /^rindle-wasm-bin/, replacement: wasmBin }],
  },
});
