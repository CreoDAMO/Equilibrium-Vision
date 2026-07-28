---
name: verify_residual worker
description: WasmVM.call() dispatches to a Worker thread (dist/chain/wasm-worker.mjs) so execFileSync in verify_residual doesn't block the main event loop.
---

## How it works

- `WasmVM.call()` checks `isMainThread && hostCtx && WORKER_SCRIPT`; only then spawns a Worker.
- Worker receives contracts snapshot + call spec via `workerData`.
- Host-context ops (getBalance, credit, debit, getGovParam, dexMultiSwap) proxy back to main thread via `MessageChannel` + `receiveMessageOnPort()` (synchronous in worker, async event-loop in main).
- Worker returns `contractUpdates` (storage, callCount, totalGasUsed, events) which main thread applies via `firePersist`.
- Falls back to sync `execCall` when: not main thread (prevents cascading), no hostCtx (unit tests), or WORKER_SCRIPT absent (vitest without prior build).

## Build

- `build.mjs` has two entry points: `src/index.ts` and `src/chain/wasm-worker.ts`.
- Output: `dist/chain/wasm-worker.mjs` (esbuild mirrors src tree, NOT dist/wasm-worker.mjs).
- WORKER_SCRIPT candidates: `dist/chain/wasm-worker.mjs` (cwd-relative), `chain/wasm-worker.mjs` (__dirname-relative), `wasm-worker.mjs` (same dir).

**Why:** execFileSync in verify_residual blocks the Node.js event loop up to 10s. Worker thread isolates this blocking so the API server stays responsive during contract execution.

**How to apply:** Any new host import that does heavy sync work should go through the worker — ProxyHostContext in wasm-worker.ts is the extension point.
