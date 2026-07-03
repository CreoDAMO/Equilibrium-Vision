/**
 * @equilibrium/sdk — Typed TypeScript client for the Equilibrium node RPC.
 *
 * Works in Node.js, browsers, and any environment with a native `fetch`.
 * No framework dependency — framework-specific wrappers (React hooks, etc.)
 * are in @workspace/api-client-react.
 *
 * Usage:
 *   import { EquilibriumClient } from "@equilibrium/sdk";
 *   const client = new EquilibriumClient({ baseUrl: "https://your-node.example.com" });
 *   const status = await client.chain.getStatus();
 */

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ClientOptions {
  /** Base URL of the node API, e.g. "https://node.example.com". No trailing slash. */
  baseUrl: string;
  /** Optional API key passed as `X-Api-Key` header. */
  apiKey?: string;
  /** Milliseconds before a request is aborted. Default: 30 000. */
  timeoutMs?: number;
}

export interface ChainStatus {
  height: number;
  latestHash: string;
  latestTimestamp: number;
  totalTxCount: number;
  mempoolSize: number;
  mempoolPressure: number;
  validatorCount: number;
  cumulativeWork: number;
  lastResidual: number;
  avgBlockTime: number;
  tps: number;
}

export interface BlockStat {
  height: number;
  txCount: number;
  residual: number;
  mempoolPressure: number;
  timestamp: number;
}

export interface Block {
  hash: string;
  height: number;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: number;
  difficulty: number;
  residual: number;
  miner: string;
  txCount: number;
  coinbaseReward: number;
  finalized: boolean;
  transactions?: Transaction[];
}

export interface Transaction {
  hash: string;
  blockHash?: string;
  blockHeight?: number;
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  signature: string;
  status: "pending" | "confirmed" | "failed";
  timestamp: number;
}

export interface AddressInfo {
  address: string;
  balance: number;
  txCount: number;
  transactions: Transaction[];
}

export interface Mempool {
  size: number;
  pressure: number;
  transactions: Transaction[];
}

export interface Peer {
  peerId: string;
  address: string;
  latencyMs: number;
  height: number;
  connected: boolean;
}

export interface Validator {
  address: string;
  stake: number;
  delegatedStake: number;
  active: boolean;
  slashCount: number;
}

export interface BroadcastResult {
  hash: string;
  accepted: boolean;
  error?: string;
}

export interface DexPool {
  id: string;
  tokenA: string;
  tokenB: string;
  reserveA: number;
  reserveB: number;
  lpSupply: number;
  fee: number;
}

export interface DexQuote {
  poolId: string;
  amountIn: number;
  amountOut: number;
  priceImpact: number;
  fee: number;
}

export interface FaucetStatus {
  address: string;
  eligible: boolean;
  lastClaim?: number;
  nextClaimAt?: number;
}

// ── Request helpers ───────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export { ApiError };

// ── Namespace clients ─────────────────────────────────────────────────────────

class HttpClient {
  constructor(private readonly opts: Required<ClientOptions>) {}

  async get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const url = new URL(`${this.opts.baseUrl}/api${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return this.request<T>(url.toString(), { method: "GET" });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.baseUrl}/api${path}`;
    return this.request<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string>),
        Accept: "application/json",
      };
      if (this.opts.apiKey) headers["X-Api-Key"] = this.opts.apiKey;

      const res = await fetch(url, { ...init, headers, signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body, `HTTP ${res.status}: ${url}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Chain namespace ───────────────────────────────────────────────────────────

class ChainClient {
  constructor(private readonly http: HttpClient) {}

  /** Current chain state and network metrics. */
  getStatus(): Promise<ChainStatus> { return this.http.get("/chain/status"); }

  /** Historical stats for the last 20 blocks (for sparklines). */
  getStats(): Promise<BlockStat[]> { return this.http.get("/chain/stats"); }

  /** Connected peer list. */
  getPeers(): Promise<Peer[]> { return this.http.get("/network/peers"); }
}

// ── Blocks namespace ──────────────────────────────────────────────────────────

class BlocksClient {
  constructor(private readonly http: HttpClient) {}

  /** List recent blocks. */
  list(params?: { limit?: number; offset?: number }): Promise<Block[]> {
    return this.http.get("/blocks", params as Record<string, number>);
  }

  /** Get a block by hash or height. */
  get(hashOrHeight: string | number): Promise<Block> {
    return this.http.get(`/blocks/${hashOrHeight}`);
  }
}

// ── Transactions namespace ────────────────────────────────────────────────────

class TransactionsClient {
  constructor(private readonly http: HttpClient) {}

  /** Get a transaction by hash. */
  get(hash: string): Promise<Transaction> { return this.http.get(`/tx/${hash}`); }

  /** Broadcast a signed transaction. */
  broadcast(signedTx: {
    from: string;
    to: string;
    amount: number;
    fee: number;
    nonce: number;
    signature: string;
  }): Promise<BroadcastResult> {
    return this.http.post("/tx/broadcast", signedTx);
  }
}

// ── Addresses namespace ───────────────────────────────────────────────────────

class AddressesClient {
  constructor(private readonly http: HttpClient) {}

  /** Get balance and transaction history for an address. */
  get(address: string): Promise<AddressInfo> { return this.http.get(`/address/${address}`); }
}

// ── Mempool namespace ─────────────────────────────────────────────────────────

class MempoolClient {
  constructor(private readonly http: HttpClient) {}

  /** Current mempool contents, size, and pressure. */
  get(): Promise<Mempool> { return this.http.get("/mempool"); }
}

// ── Validators namespace ──────────────────────────────────────────────────────

class ValidatorsClient {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<Validator[]>           { return this.http.get("/validators"); }
  get(address: string): Promise<Validator> { return this.http.get(`/validators/${address}`); }

  stake(params: { address: string; amount: number; signature: string }): Promise<void> {
    return this.http.post("/stake", params);
  }
  unstake(params: { address: string; amount: number; signature: string }): Promise<void> {
    return this.http.post("/unstake", params);
  }
}

// ── DEX namespace ─────────────────────────────────────────────────────────────

class DexClient {
  constructor(private readonly http: HttpClient) {}

  listPools(): Promise<DexPool[]>         { return this.http.get("/dex/pools"); }
  getPool(id: string): Promise<DexPool>   { return this.http.get(`/dex/pools/${id}`); }

  quote(params: { poolId: string; tokenIn: string; amountIn: number }): Promise<DexQuote> {
    return this.http.get("/dex/quote", params as unknown as Record<string, string | number | boolean>);
  }

  swap(params: { poolId: string; tokenIn: string; amountIn: number; minAmountOut: number; signature: string }): Promise<{ hash: string }> {
    return this.http.post("/dex/swap", params);
  }
}

// ── Faucet namespace ──────────────────────────────────────────────────────────

class FaucetClient {
  constructor(private readonly http: HttpClient) {}

  status(address: string): Promise<FaucetStatus> { return this.http.get(`/faucet/status/${address}`); }
  drip(address: string): Promise<{ hash: string; amount: number }> {
    return this.http.post("/faucet", { address });
  }
}

// ── Main client ───────────────────────────────────────────────────────────────

/**
 * Top-level Equilibrium SDK client.
 *
 * @example
 * ```ts
 * const client = new EquilibriumClient({ baseUrl: "https://node.example.com" });
 * const status  = await client.chain.getStatus();
 * const blocks  = await client.blocks.list({ limit: 10 });
 * const balance = await client.addresses.get("abc123...");
 * ```
 */
export class EquilibriumClient {
  readonly chain:        ChainClient;
  readonly blocks:       BlocksClient;
  readonly transactions: TransactionsClient;
  readonly addresses:    AddressesClient;
  readonly mempool:      MempoolClient;
  readonly validators:   ValidatorsClient;
  readonly dex:          DexClient;
  readonly faucet:       FaucetClient;

  constructor(opts: ClientOptions) {
    const resolved: Required<ClientOptions> = {
      baseUrl:   opts.baseUrl.replace(/\/$/, ""),
      apiKey:    opts.apiKey ?? "",
      timeoutMs: opts.timeoutMs ?? 30_000,
    };
    const http = new HttpClient(resolved);

    this.chain        = new ChainClient(http);
    this.blocks       = new BlocksClient(http);
    this.transactions = new TransactionsClient(http);
    this.addresses    = new AddressesClient(http);
    this.mempool      = new MempoolClient(http);
    this.validators   = new ValidatorsClient(http);
    this.dex          = new DexClient(http);
    this.faucet       = new FaucetClient(http);
  }
}

// ── WebSocket subscription helper ─────────────────────────────────────────────

export type WsEvent =
  | { type: "connected" }
  | { type: "ping" }
  | { type: "new_block";      data: { height: number; hash: string; txCount: number; residual: number; miner: string; timestamp: number } }
  | { type: "mempool_update"; data: { size: number; pressure: number } };

export type WsEventHandler = (event: WsEvent) => void;

/**
 * Subscribe to real-time chain events over WebSocket.
 *
 * @example
 * ```ts
 * const unsub = subscribeToChain("wss://node.example.com/ws", (event) => {
 *   if (event.type === "new_block") console.log("New block:", event.data.height);
 * });
 * // Later:
 * unsub();
 * ```
 */
export function subscribeToChain(
  wsUrl: string,
  handler: WsEventHandler,
  options: { reconnectMs?: number } = {},
): () => void {
  const { reconnectMs = 3_000 } = options;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function connect() {
    if (stopped) return;
    ws = new WebSocket(wsUrl);

    ws.onmessage = (e: MessageEvent<string>) => {
      try { handler(JSON.parse(e.data) as WsEvent); } catch {}
    };

    ws.onclose = () => {
      ws = null;
      if (!stopped) timer = setTimeout(connect, reconnectMs);
    };

    ws.onerror = () => ws?.close();
  }

  connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
