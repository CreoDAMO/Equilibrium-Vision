import { ARBITRAGE_WASM } from "./arbitrage-wasm";
import { sha256Hex } from "./crypto";

/** sha256 of the wasm bytes this process executes. Not an APK. */
export const EMBEDDED_WASM = sha256Hex(ARBITRAGE_WASM);

/**
 * Identity of a source tree. The live host names a commit only by reading
 * `RENDER_GIT_COMMIT` (or `EQUILIBRIUM_COMMIT`) and this wasm hash.
 * The hash does not make equilibrium a second successor.
 */
export function deploymentIdentity(parts: {
  commit: string;
  node: string;
  rustc: string;
  siteLock: string;
  workspaceLock: string;
  wasm: string;
  contract: string;
}): string {
  return sha256Hex(
    `eq-deploy|${parts.commit}|${parts.node}|${parts.rustc}|${parts.siteLock}|${parts.workspaceLock}|${parts.wasm}|${parts.contract}`,
  );
}
