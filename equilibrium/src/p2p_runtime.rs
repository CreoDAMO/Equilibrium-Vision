//! In-process libp2p runtime for mobile and embedded nodes.
//!
//! The desktop p2p-sidecar remains the richer JSON bridge used by the TypeScript
//! node.  This module has no stdin/stdout or HTTP dependency: an Android/iOS host
//! starts the swarm in its own process and feeds it a first-contact multiaddr
//! directly via QR-code or NFC invite.
//!
//! ## Capabilities (Phase A–C)
//! - **Gossipsub** — block hashes, TX hashes, and full block bodies
//! - **Light-node RR** (`/equilibrium/lightnode/1.0.0`) — tip queries peer-to-peer
//! - **Sync RR** (`/equilibrium/sync/1.0.0`) — full block body fetch, phone↔phone
//! - **Identify + Kademlia** — peer discovery without seed nodes
//! - **Tip cache** — `fetch_tip` / `set_local_tip` (no HTTP round-trip)
//! - **Block ring** — last 64 accepted blocks, served to peers via sync RR

use futures::{future::Either, StreamExt};
use libp2p::{
    core::{
        muxing::StreamMuxerBox,
        transport::{Boxed, OrTransport},
        upgrade::Version,
    },
    gossipsub, identify, kad, noise, request_response,
    swarm::{Config as SwarmConfig, NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol, Transport,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fs,
    io::Write,
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
        Mutex, OnceLock, RwLock,
    },
    thread,
    time::Duration,
};

// ── Protocol IDs ──────────────────────────────────────────────────────────────

const GOSSIP_BLOCKS:       &str = "equilibrium/blocks/1.0.0";
const GOSSIP_TXS:          &str = "equilibrium/txs/1.0.0";
/// Full block body gossip — phones publish after a successful solve so peers
/// can store the body and serve it via sync RR without an HTTP node.
const GOSSIP_BLOCK_BODIES: &str = "equilibrium/block-bodies/1.0.0";
const LIGHTNODE_PROTO:     &str = "/equilibrium/lightnode/1.0.0";
const SYNC_PROTO:          &str = "/equilibrium/sync/1.0.0";
const IDENTIFY_PROTO:      &str = "/equilibrium/id/1.0.0";

const GOSSIP_QUEUE_CAP: usize = 128;
const BLOCK_RING_CAP:   usize = 64;

// ── Wire types (identical JSON shapes to the desktop p2p-sidecar) ─────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LightnodeReq {
    id:     String,
    /// "tip" | "headers" | "proof_account" | "proof_utxo"
    kind:   String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LightnodeResp {
    id:    String,
    ok:    bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data:  Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncReq {
    id:     String,
    /// "block" | "blocks" | "tx" | "txs"
    kind:   String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncResp {
    id:    String,
    ok:    bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data:  Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Tip cache ─────────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct TipCache {
    height:     u64,
    hash:       String,
    difficulty: u64,
}

static TIP_CACHE: OnceLock<RwLock<TipCache>> = OnceLock::new();

fn tip_cache() -> &'static RwLock<TipCache> {
    TIP_CACHE.get_or_init(|| RwLock::new(TipCache::default()))
}

// ── Block ring ────────────────────────────────────────────────────────────────
// Last BLOCK_RING_CAP accepted block bodies as JSON strings.
// Filled by gossip_block_body() or push_block_body(), drained by sync RR server.

static BLOCK_RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn block_ring() -> &'static Mutex<VecDeque<String>> {
    BLOCK_RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(BLOCK_RING_CAP)))
}

fn push_to_block_ring(json: &str) {
    let mut ring = block_ring().lock().expect("block ring poisoned");
    if ring.len() >= BLOCK_RING_CAP { ring.pop_front(); }
    ring.push_back(json.to_string());
}

fn find_block_in_ring(hash: &str) -> Option<String> {
    let ring = block_ring().lock().expect("block ring poisoned");
    ring.iter().find(|body| {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v["hash"].as_str().map(|h| h == hash))
            .unwrap_or(false)
    }).cloned()
}

fn blocks_in_ring_range(from: u64, to: u64) -> Vec<Value> {
    let ring = block_ring().lock().expect("block ring poisoned");
    ring.iter()
        .filter_map(|body| serde_json::from_str::<Value>(body).ok())
        .filter(|v| {
            v["height"].as_u64().map(|h| h >= from && h <= to).unwrap_or(false)
        })
        .collect()
}

// ── NetworkBehaviour ──────────────────────────────────────────────────────────

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    identify:  identify::Behaviour,
    kad:       kad::Behaviour<kad::store::MemoryStore>,
    /// Light-node RR: tip, headers, compact SMT proofs — no HTTP required.
    lightnode: request_response::json::Behaviour<LightnodeReq, LightnodeResp>,
    /// Sync RR: full block/TX body fetch — phone can pull bodies from peers.
    sync_rr:   request_response::json::Behaviour<SyncReq, SyncResp>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Reply channel type for blocking RR queries (caller blocks on recv_timeout).
type ReplySender = mpsc::Sender<Option<String>>;

enum Command {
    Dial(Multiaddr),
    /// Publish a solved block hash via Gossipsub (race-detection).
    GossipBlock(String),
    /// Publish a full block body via Gossipsub + push to local ring.
    GossipBlockBody(String),
    /// Ask a connected peer for its tip via lightnode RR.
    QueryLightnode { req: LightnodeReq, reply: ReplySender },
    /// Ask a connected peer for a block/blocks via sync RR.
    QuerySync { req: SyncReq, reply: ReplySender },
}

// ── Statics ───────────────────────────────────────────────────────────────────

static RUNNING:      AtomicBool = AtomicBool::new(false);
static COMMANDS:     OnceLock<Mutex<Option<Sender<Command>>>> = OnceLock::new();
/// Inbound block hashes from remote peers — polled by MiningWorker for race detection.
static GOSSIP_QUEUE: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
/// Live count of established connections, updated in the swarm event loop.
static CONNECTED_PEER_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn command_slot() -> &'static Mutex<Option<Sender<Command>>> {
    COMMANDS.get_or_init(|| Mutex::new(None))
}

fn gossip_queue() -> &'static Mutex<VecDeque<String>> {
    GOSSIP_QUEUE.get_or_init(|| Mutex::new(VecDeque::with_capacity(GOSSIP_QUEUE_CAP)))
}

// ── Transport builder ─────────────────────────────────────────────────────────

fn make_transport(keys: &libp2p::identity::Keypair) -> Boxed<(PeerId, StreamMuxerBox)> {
    let quic_transport = libp2p::quic::tokio::Transport::new(libp2p::quic::Config::new(keys));
    let tcp_transport = tcp::tokio::Transport::default()
        .upgrade(Version::V1)
        .authenticate(noise::Config::new(keys).expect("valid noise key"))
        .multiplex(yamux::Config::default());

    OrTransport::new(quic_transport, tcp_transport)
        .map(|output, _| match output {
            Either::Left((peer, muxer))  => (peer, StreamMuxerBox::new(muxer)),
            Either::Right((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
        })
        .boxed()
}

// ── Public lifecycle API ──────────────────────────────────────────────────────

/// Start a background dual-transport swarm on `listen_tcp` (TCP) and
/// `listen_quic` (QUIC/UDP). Pass `0` for `listen_quic` to disable QUIC.
/// Returns `false` if the swarm is already running.
pub fn start(listen_tcp: u16, listen_quic: u16) -> bool {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return false;
    }

    let (tx, rx) = mpsc::channel::<Command>();
    *command_slot().lock().expect("command mutex poisoned") = Some(tx);

    thread::Builder::new()
        .name("equilibrium-p2p".to_string())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map(|runtime| {
                    runtime.block_on(async move {
                        run_swarm(rx, listen_tcp, listen_quic).await
                    });
                });
            if let Err(error) = result {
                eprintln!("[p2p-runtime] stopped: {error}");
            }
            *command_slot().lock().expect("command mutex poisoned") = None;
            RUNNING.store(false, Ordering::Release);
        })
        .is_ok()
}

/// Stop the swarm background thread.
pub fn stop() {
    RUNNING.store(false, Ordering::Release);
    *command_slot().lock().expect("command mutex poisoned") = None;
}

/// Whether the swarm is currently running.
pub fn is_running() -> bool {
    RUNNING.load(Ordering::Acquire)
}

/// Dial a remote peer by multiaddr.
pub fn connect(addr: &str) -> bool {
    let Ok(multiaddr) = Multiaddr::from_str(addr) else { return false; };
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else { return false; };
    sender.send(Command::Dial(multiaddr)).is_ok()
}

/// Publish a solved block hash to all connected peers via Gossipsub.
/// Returns `false` if the swarm is not running or the channel is full.
pub fn gossip_block(hash: &str) -> bool {
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else { return false; };
    sender.send(Command::GossipBlock(hash.to_string())).is_ok()
}

/// Publish a full block body JSON to connected peers via Gossipsub.
/// Also stores the body in the local block ring so peers can fetch it via sync RR.
pub fn gossip_block_body(json: &str) -> bool {
    push_to_block_ring(json);  // store locally first (Phase B: serve via sync RR)
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else { return false; };
    sender.send(Command::GossipBlockBody(json.to_string())).is_ok()
}

/// Push a block body JSON string into the local ring buffer without gossiping.
/// Call this after accepting a block from any source (HTTP, gossip, sync RR)
/// so the phone can serve it to other peers via sync RR.
pub fn push_block_body(json: &str) {
    push_to_block_ring(json);
}

/// Pop the next inbound block hash from the gossip queue, or `None` if empty.
///
/// The Android mining loop calls this to detect competing solutions that arrived
/// while the solver was running, and skips re-solving a height already won.
pub fn poll_gossip() -> Option<String> {
    gossip_queue()
        .lock()
        .expect("gossip queue poisoned")
        .pop_front()
}

// ── Tip cache public API ──────────────────────────────────────────────────────

/// Return the locally-cached chain tip as a JSON string, or an empty string
/// if no tip has been stored yet.
///
/// JSON format: `{"height":<u64>,"hash":"<hex>","difficulty":<u64>}`
pub fn fetch_tip() -> String {
    let cache = tip_cache().read().expect("tip cache read poisoned");
    if cache.hash.is_empty() { return String::new(); }
    format!(
        r#"{{"height":{},"hash":"{}","difficulty":{}}}"#,
        cache.height, cache.hash, cache.difficulty,
    )
}

/// Update the local tip cache. Returns `true` if the height advanced.
pub fn set_local_tip(height: u64, hash: &str, difficulty: u64) -> bool {
    let mut cache = tip_cache().write().expect("tip cache write poisoned");
    if height > cache.height {
        cache.height     = height;
        cache.hash       = hash.to_string();
        cache.difficulty = difficulty;
        eprintln!("[p2p-runtime] tip updated: height={height} hash={hash}");
        true
    } else {
        false
    }
}

// ── P2P RR query API (Phase A — mobile as client) ─────────────────────────────

/// Ask a connected peer for its chain tip via the lightnode RR protocol.
/// Returns a JSON string `{"height":...,"hash":"...","difficulty":...}`,
/// or an empty string if no peer is reachable or the request times out (5 s).
///
/// MiningWorker tip priority:
///   1. `fetch_tip()`           — local cache (instant, no network)
///   2. `query_lightnode_tip()` — P2P lightnode RR (this, ~1–5 s)
///   3. HTTP `/api/chain/status`— last resort
pub fn query_lightnode_tip() -> String {
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else { return String::new(); };

    let (reply_tx, reply_rx) = mpsc::channel::<Option<String>>();
    let req = LightnodeReq {
        id:     "tip-query".to_string(),
        kind:   "tip".to_string(),
        params: Value::Null,
    };
    if sender.send(Command::QueryLightnode { req, reply: reply_tx }).is_err() {
        return String::new();
    }
    reply_rx.recv_timeout(Duration::from_secs(5))
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Ask a connected peer for a full block body by hash via the sync RR protocol.
/// Checks the local block ring first to avoid a network round-trip.
/// Returns the block JSON string, or an empty string on failure / timeout.
pub fn query_sync_block(hash: &str) -> String {
    // Fast path: check local ring (populated by body gossip or prior RR fetches)
    if let Some(body) = find_block_in_ring(hash) {
        return body;
    }
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else { return String::new(); };

    let (reply_tx, reply_rx) = mpsc::channel::<Option<String>>();
    let req = SyncReq {
        id:     format!("sync-{}", &hash[..8.min(hash.len())]),
        kind:   "block".to_string(),
        params: serde_json::json!({ "hash": hash }),
    };
    if sender.send(Command::QuerySync { req, reply: reply_tx }).is_err() {
        return String::new();
    }
    reply_rx.recv_timeout(Duration::from_secs(10))
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Ask a connected peer for a range of block bodies via the sync RR protocol.
/// Returns a JSON array string `{"blocks":[...]}`, or an empty string on failure.
pub fn query_sync_blocks(from_height: u64, to_height: u64) -> String {
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else { return String::new(); };

    let (reply_tx, reply_rx) = mpsc::channel::<Option<String>>();
    let req = SyncReq {
        id:     format!("sync-{from_height}-{to_height}"),
        kind:   "blocks".to_string(),
        params: serde_json::json!({ "from": from_height, "to": to_height }),
    };
    if sender.send(Command::QuerySync { req, reply: reply_tx }).is_err() {
        return String::new();
    }
    reply_rx.recv_timeout(Duration::from_secs(10))
        .ok()
        .flatten()
        .unwrap_or_default()
}

// ── Bootstrap peer helpers ────────────────────────────────────────────────────

/// Path to the persistent known-peers JSON file: `~/.equilibrium/known_peers.json`.
fn known_peers_path() -> PathBuf {
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".equilibrium").join("known_peers.json")
}

/// Load multiaddrs to dial on startup from two sources (deduplicated):
///   1. `BOOTSTRAP_PEERS` env var — comma-separated multiaddrs
///   2. `~/.equilibrium/known_peers.json` — persisted from previous sessions
fn load_bootstrap_addrs() -> Vec<Multiaddr> {
    let mut addrs: Vec<Multiaddr> = Vec::new();

    // 1. Env var
    if let Ok(peers_env) = env::var("BOOTSTRAP_PEERS") {
        for raw in peers_env.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            match Multiaddr::from_str(raw) {
                Ok(a) => { addrs.push(a); }
                Err(e) => { eprintln!("[p2p-runtime] bad BOOTSTRAP_PEERS entry '{raw}': {e}"); }
            }
        }
    }

    // 2. Persisted routing table
    let path = known_peers_path();
    if let Ok(data) = fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&data) {
            for raw in &list {
                if let Ok(a) = Multiaddr::from_str(raw) {
                    if !addrs.contains(&a) {
                        addrs.push(a);
                    }
                }
            }
        }
    }

    addrs
}

/// Persist a dialed peer's observed multiaddr to `~/.equilibrium/known_peers.json`
/// so future cold starts can skip manual QR pairing.
fn persist_peer_addr(addr: &Multiaddr) {
    let path = known_peers_path();
    // Create parent dir if needed
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // Read existing list
    let mut list: Vec<String> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let addr_str = addr.to_string();
    if !list.contains(&addr_str) {
        list.push(addr_str);
        if let Ok(json) = serde_json::to_string(&list) {
            if let Ok(mut f) = fs::File::create(&path) {
                let _ = f.write_all(json.as_bytes());
            }
        }
    }
}

// ── Swarm event loop ──────────────────────────────────────────────────────────

async fn run_swarm(rx: mpsc::Receiver<Command>, listen_tcp: u16, listen_quic: u16) {
    let keys         = libp2p::identity::Keypair::generate_ed25519();
    let peer_id      = PeerId::from(keys.public());
    let topic_blocks = gossipsub::IdentTopic::new(GOSSIP_BLOCKS);
    let topic_txs    = gossipsub::IdentTopic::new(GOSSIP_TXS);
    let topic_bodies = gossipsub::IdentTopic::new(GOSSIP_BLOCK_BODIES);

    let mut gossip = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(keys.clone()),
        gossipsub::Config::default(),
    ).expect("valid gossipsub config");
    let _ = gossip.subscribe(&topic_blocks);
    let _ = gossip.subscribe(&topic_txs);
    let _ = gossip.subscribe(&topic_bodies);

    let identify = identify::Behaviour::new(
        identify::Config::new(IDENTIFY_PROTO.to_string(), keys.public())
            .with_push_listen_addr_updates(true),
    );
    let mut kad = kad::Behaviour::new(peer_id, kad::store::MemoryStore::new(peer_id));
    kad.set_mode(Some(kad::Mode::Server));

    let lightnode_beh = request_response::json::Behaviour::<LightnodeReq, LightnodeResp>::new(
        [(StreamProtocol::new(LIGHTNODE_PROTO), request_response::ProtocolSupport::Full)],
        request_response::Config::default(),
    );
    let sync_rr_beh = request_response::json::Behaviour::<SyncReq, SyncResp>::new(
        [(StreamProtocol::new(SYNC_PROTO), request_response::ProtocolSupport::Full)],
        request_response::Config::default(),
    );

    let mut swarm = libp2p::Swarm::new(
        make_transport(&keys),
        Behaviour { gossipsub: gossip, identify, kad, lightnode: lightnode_beh, sync_rr: sync_rr_beh },
        peer_id,
        SwarmConfig::with_tokio_executor(),
    );

    if let Ok(addr) = format!("/ip4/0.0.0.0/tcp/{listen_tcp}").parse() {
        if let Err(e) = swarm.listen_on(addr) {
            eprintln!("[p2p-runtime] TCP listen failed: {e}");
        }
    }
    if listen_quic > 0 {
        if let Ok(addr) = format!("/ip4/0.0.0.0/udp/{listen_quic}/quic-v1").parse() {
            if let Err(e) = swarm.listen_on(addr) {
                eprintln!("[p2p-runtime] QUIC listen failed: {e}");
            }
        }
    }
    eprintln!("[p2p-runtime] peer_id={peer_id}");

    // Dial bootstrap peers (env var + persisted routing table) before entering
    // the event loop so the swarm starts connecting immediately.
    let bootstrap_addrs = load_bootstrap_addrs();
    if bootstrap_addrs.is_empty() {
        eprintln!("[p2p-runtime] no bootstrap peers configured; waiting for QR/NFC invite");
    } else {
        for addr in &bootstrap_addrs {
            if let Err(e) = swarm.dial(addr.clone()) {
                eprintln!("[p2p-runtime] bootstrap dial {addr} failed: {e}");
            } else {
                eprintln!("[p2p-runtime] dialing bootstrap {addr}");
            }
        }
    }

    let blocks_hash = topic_blocks.hash();
    let bodies_hash = topic_bodies.hash();

    // Pending outbound RR requests → reply channel (filled when response arrives)
    let mut ln_pending:   HashMap<request_response::OutboundRequestId, ReplySender> = HashMap::new();
    let mut sync_pending: HashMap<request_response::OutboundRequestId, ReplySender> = HashMap::new();

    // Connected peers set — needed to pick a target for outbound RR queries
    let mut connected: HashSet<PeerId> = HashSet::new();

    while RUNNING.load(Ordering::Acquire) {
        // Drain pending commands before waiting on swarm events
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Command::Dial(addr) => {
                    if let Err(e) = swarm.dial(addr.clone()) {
                        eprintln!("[p2p-runtime] dial {addr} failed: {e}");
                    }
                }
                Command::GossipBlock(hash) => {
                    match swarm.behaviour_mut().gossipsub
                        .publish(topic_blocks.clone(), hash.as_bytes().to_vec())
                    {
                        Ok(_)  => eprintln!("[p2p-runtime] gossiped block hash {hash}"),
                        Err(e) => eprintln!("[p2p-runtime] gossip_block failed: {e}"),
                    }
                }
                Command::GossipBlockBody(json) => {
                    match swarm.behaviour_mut().gossipsub
                        .publish(topic_bodies.clone(), json.as_bytes().to_vec())
                    {
                        Ok(_)  => eprintln!("[p2p-runtime] gossiped block body ({} bytes)", json.len()),
                        Err(e) => eprintln!("[p2p-runtime] gossip_block_body failed: {e}"),
                    }
                }

                // ── Phase A: outbound RR queries ─────────────────────────────
                Command::QueryLightnode { req, reply } => {
                    if let Some(&peer) = connected.iter().next() {
                        let req_id = swarm.behaviour_mut().lightnode.send_request(&peer, req);
                        ln_pending.insert(req_id, reply);
                    } else {
                        eprintln!("[p2p-runtime] queryLightnodeTip: no connected peers");
                        let _ = reply.send(None);
                    }
                }
                Command::QuerySync { req, reply } => {
                    if let Some(&peer) = connected.iter().next() {
                        let req_id = swarm.behaviour_mut().sync_rr.send_request(&peer, req);
                        sync_pending.insert(req_id, reply);
                    } else {
                        eprintln!("[p2p-runtime] querySync: no connected peers");
                        let _ = reply.send(None);
                    }
                }
            }
        }

        tokio::select! {
            event = swarm.select_next_some() => {
                match event {

                    // ── Inbound Gossipsub messages ─────────────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { message, .. }
                    )) => {
                        let topic = message.topic.clone();
                        if topic == blocks_hash {
                            // Hash-only block announcement — used for race detection
                            if let Ok(hash) = std::str::from_utf8(&message.data) {
                                let hash = hash.trim().to_string();
                                let mut q = gossip_queue().lock().expect("gossip queue poisoned");
                                if q.len() >= GOSSIP_QUEUE_CAP { q.pop_front(); }
                                q.push_back(hash.clone());
                                eprintln!("[p2p-runtime] received block hash {hash}");
                            }
                        } else if topic == bodies_hash {
                            // Full block body — update tip cache and store in ring
                            if let Ok(json) = std::str::from_utf8(&message.data) {
                                if let Ok(v) = serde_json::from_str::<Value>(json) {
                                    let height     = v["height"].as_u64().unwrap_or(0);
                                    let hash       = v["hash"].as_str().unwrap_or("").to_string();
                                    let difficulty = v["difficulty"].as_u64().unwrap_or(0);
                                    if !hash.is_empty() {
                                        set_local_tip(height, &hash, difficulty);
                                    }
                                }
                                push_to_block_ring(json);
                                eprintln!("[p2p-runtime] received block body via gossip");
                            }
                        }
                    }

                    // ── Phase B: inbound lightnode RR request (server side) ────
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::Message {
                            message: request_response::Message::Request {
                                request, channel, ..
                            }, ..
                        }
                    )) => {
                        let resp = match request.kind.as_str() {
                            "tip" => {
                                let tip_json = fetch_tip();
                                let data = serde_json::from_str::<Value>(&tip_json).ok();
                                LightnodeResp {
                                    id:    request.id.clone(),
                                    ok:    data.is_some(),
                                    data,
                                    error: if tip_json.is_empty() {
                                        Some("no tip cached on mobile".to_string())
                                    } else { None },
                                }
                            }
                            // Headers: serve block headers from the local ring.
                            // `params.from` / `params.to` optionally filter by height.
                            // Phones can answer this for the last BLOCK_RING_CAP blocks.
                            "headers" => {
                                let from_h = request.params["from"].as_u64().unwrap_or(0);
                                let to_h   = request.params.get("to")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(u64::MAX);
                                let ring = block_ring().lock().expect("block ring poisoned");
                                let headers: Vec<Value> = ring.iter()
                                    .filter_map(|body| serde_json::from_str::<Value>(body).ok())
                                    .filter(|v| {
                                        v["height"].as_u64()
                                            .map(|h| h >= from_h && h <= to_h)
                                            .unwrap_or(false)
                                    })
                                    .map(|v| serde_json::json!({
                                        "hash":       v["hash"],
                                        "height":     v["height"],
                                        "prevHash":   v["prevHash"],
                                        "timestamp":  v["timestamp"],
                                        "difficulty": v["difficulty"],
                                        "stateRoot":  v["stateRoot"],
                                        "nonce":      v["nonce"],
                                        "merkleRoot": v["merkleRoot"],
                                    }))
                                    .collect();
                                let data = serde_json::json!({ "headers": headers });
                                LightnodeResp {
                                    id:    request.id.clone(),
                                    ok:    true,
                                    data:  Some(data),
                                    error: None,
                                }
                            }
                            // Proof requests require SMT — desktop-only.
                            _ => LightnodeResp {
                                id:    request.id.clone(),
                                ok:    false,
                                data:  None,
                                error: Some("not_supported_on_mobile".to_string()),
                            },
                        };
                        let _ = swarm.behaviour_mut().lightnode.send_response(channel, resp);
                    }

                    // ── Phase A: outbound lightnode RR response (client side) ──
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::Message {
                            message: request_response::Message::Response {
                                request_id, response
                            }, ..
                        }
                    )) => {
                        if let Some(reply) = ln_pending.remove(&request_id) {
                            if response.ok {
                                if let Some(data) = &response.data {
                                    // Seed local tip cache from the peer's reply
                                    let h = data["height"].as_u64().unwrap_or(0);
                                    let hash = data["hash"].as_str().unwrap_or("").to_string();
                                    let d = data["difficulty"].as_u64().unwrap_or(0);
                                    if !hash.is_empty() {
                                        set_local_tip(h, &hash, d);
                                    }
                                }
                                let json = response.data
                                    .as_ref()
                                    .and_then(|d| serde_json::to_string(d).ok());
                                let _ = reply.send(json);
                            } else {
                                let _ = reply.send(None);
                            }
                        }
                    }

                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::OutboundFailure { request_id, error, .. }
                    )) => {
                        eprintln!("[p2p-runtime] lightnode outbound failure: {error}");
                        if let Some(reply) = ln_pending.remove(&request_id) {
                            let _ = reply.send(None);
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(_)) => {}

                    // ── Phase B: inbound sync RR request (server side) ─────────
                    SwarmEvent::Behaviour(BehaviourEvent::SyncRr(
                        request_response::Event::Message {
                            message: request_response::Message::Request {
                                request, channel, ..
                            }, ..
                        }
                    )) => {
                        let resp = match request.kind.as_str() {
                            "block" => {
                                let hash = request.params["hash"].as_str().unwrap_or("");
                                match find_block_in_ring(hash) {
                                    Some(body) => {
                                        let data = serde_json::from_str::<Value>(&body).ok();
                                        SyncResp { id: request.id.clone(), ok: true, data, error: None }
                                    }
                                    None => SyncResp {
                                        id:    request.id.clone(),
                                        ok:    false,
                                        data:  None,
                                        error: Some("block not in local ring".to_string()),
                                    },
                                }
                            }
                            "blocks" => {
                                let from = request.params["from"].as_u64().unwrap_or(0);
                                let to   = request.params["to"].as_u64().unwrap_or(0);
                                let blocks = blocks_in_ring_range(from, to);
                                let data = serde_json::json!({ "blocks": blocks });
                                SyncResp { id: request.id.clone(), ok: true, data: Some(data), error: None }
                            }
                            // TX body requests and proof requests not supported on mobile v1
                            _ => SyncResp {
                                id:    request.id.clone(),
                                ok:    false,
                                data:  None,
                                error: Some("not_supported_on_mobile".to_string()),
                            },
                        };
                        let _ = swarm.behaviour_mut().sync_rr.send_response(channel, resp);
                    }

                    // ── Phase A: outbound sync RR response (client side) ───────
                    SwarmEvent::Behaviour(BehaviourEvent::SyncRr(
                        request_response::Event::Message {
                            message: request_response::Message::Response {
                                request_id, response
                            }, ..
                        }
                    )) => {
                        if let Some(reply) = sync_pending.remove(&request_id) {
                            if response.ok {
                                let json = response.data
                                    .as_ref()
                                    .and_then(|d| serde_json::to_string(d).ok());
                                let _ = reply.send(json);
                            } else {
                                let _ = reply.send(None);
                            }
                        }
                    }

                    SwarmEvent::Behaviour(BehaviourEvent::SyncRr(
                        request_response::Event::OutboundFailure { request_id, error, .. }
                    )) => {
                        eprintln!("[p2p-runtime] sync outbound failure: {error}");
                        if let Some(reply) = sync_pending.remove(&request_id) {
                            let _ = reply.send(None);
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::SyncRr(_)) => {}

                    // ── Connection lifecycle ───────────────────────────────────
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        connected.insert(peer_id);
                        CONNECTED_PEER_COUNT.store(connected.len(), Ordering::Relaxed);
                        if let libp2p::core::ConnectedPoint::Dialer { address, .. } = endpoint {
                            swarm.behaviour_mut().kad.add_address(&peer_id, address.clone());
                            // Persist address for faster reconnect on next cold start
                            persist_peer_addr(&address);
                        }
                        let _ = swarm.behaviour_mut().kad.bootstrap();
                        eprintln!("[p2p-runtime] connected: {peer_id} ({} peers)", connected.len());
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        connected.remove(&peer_id);
                        CONNECTED_PEER_COUNT.store(connected.len(), Ordering::Relaxed);
                        eprintln!("[p2p-runtime] disconnected: {peer_id} ({} peers)", connected.len());
                    }

                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

/// Return the number of currently established peer connections.
/// Updated atomically in the swarm event loop on every connect/disconnect.
pub fn get_connected_peer_count() -> u32 {
    CONNECTED_PEER_COUNT.load(Ordering::Relaxed) as u32
}
