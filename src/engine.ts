// Booting the engine, and holding a handle to what it actually weighs.
//
// `packages/wasm/pkg/rindle.js` is a wasm-bindgen `--target web` module whose default export is
// idempotent — `if (wasm !== undefined) return wasm` — and returns the instance's exports,
// `memory` among them. So after `@rindle/wasm`'s own `initWasm` has run, calling the raw init
// again returns immediately, instantiates nothing, and hands back the live `WebAssembly.Memory`.
// `memory.buffer.byteLength` is then not an estimate of the engine's footprint; it IS the
// engine's footprint, to the page.
//
// That relies on both importers resolving `pkg/rindle.js` to the same ES module instance. They
// do (same file, same specifier target), but "usually true" is not good enough for a number the
// page shows, so `test/browser-smoke.mjs` verifies it in the BUILT bundle: it pushes thousands
// of rows and asserts this handle's reading moved. A handle to some second, accidental instance
// would sit still there and fail CI rather than reporting a wrong number silently.

import rawInit from "@rindle/wasm/pkg/rindle.js";
import { Store, initWasm } from "@rindle/wasm";
import { WasmBackend } from "@rindle/wasm";

import { schema, type DrawCols } from "./schema.ts";

export type DrawStore = Store<DrawCols>;

export interface Engine {
  store: DrawStore;
  /** Current wasm linear-memory size in bytes, or `null` where the handle could not be taken. */
  wasmHeapBytes(): number | null;
}

async function probeWasmMemory(): Promise<WebAssembly.Memory | null> {
  try {
    // No argument: the module is already initialized, so this returns the cached exports without
    // touching the network. (`boot` only calls it after `initWasm` has resolved.)
    const exports = (await (rawInit as unknown as (a?: unknown) => Promise<unknown>)()) as
      | { memory?: WebAssembly.Memory }
      | undefined;
    return exports?.memory instanceof WebAssembly.Memory ? exports.memory : null;
  } catch {
    return null;
  }
}

/** Boot the engine. `wasmUrl` is the bundler-resolved URL of `rindle_bg.wasm` in the browser; in
 *  Node leave it undefined and `@rindle/wasm` reads the bytes out of the package itself. */
export async function boot(wasmUrl?: string): Promise<Engine> {
  await initWasm(wasmUrl);
  const memory = await probeWasmMemory();
  const store = new Store(schema, new WasmBackend(schema));
  return {
    store,
    wasmHeapBytes: () => (memory ? memory.buffer.byteLength : null),
  };
}
