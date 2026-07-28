//! In-process libp2p runtime for mobile and embedded nodes.
//!
//! The desktop sidecar remains the richer JSON bridge used by the TypeScript
//! node.  This module deliberately has no stdin/stdout or HTTP dependency: an
//! Android/iOS host can start the swarm in its own process and feed it a
//! first-contact multiaddr directly.
//!
//! ## Capabilities
//! - Dual TCP + QUIC transport (OrTransport)
//! - Gossipsub block/tx announcement (GOSSIP_BLOCKS, GOSSIP_TXS topics)
//! - Identify — advertise multiaddrs to peers
//! - Kademlia (server mode) — DHT peer routing
//! - gossip_block(hash) — publish a solved block hash to all connected peers
//! - poll_gossip()      — pop the next inbound block hash received from peers
//!   (used by the Android mining loop to detect competing solutions)

use futures::{future::Either, StreamExt};
use libp2p::{
    core::{
        muxing::StreamMuxerBox,
        transport::{Boxed, OrTransport},
        upgrade::Version,
    },
    gossipsub, identify, kad, noise,
    swarm::{Config as SwarmConfig, NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, Transport,
};
use std::{
    collections::VecDeque,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
        Mutex, OnceLock, RwLock,
    },
    thread,
};

const GOSSIP_BLOCKS: &str = "equilibrium/blocks/1.0.0";
const GOSSIP_TXS: &str = "equilibrium/txs/1.0.0";
const IDENTIFY_PROTO: &str = "/equilibrium/id/1.0.0";

/// Maximum inbound block hashes buffered before the oldest is dropped.
const GOSSIP_QUEUE_CAP: usize = 128;

// ── Local tip cache ────────────────────────────────────────────────────────────
//
// Stored whenever the Kotlin host accepts a block (via set_local_tip) or
// receives one from a peer. Kotlin reads it via fetch_tip to avoid an HTTP
// round-trip to the cloud node when at least one peer is reachable.

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

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    identify:  identify::Behaviour,
    kad:       kad::Behaviour<kad::store::MemoryStore>,
}

enum Command {
    Dial(Multiaddr),
    /// Publish a solved block hash to all connected peers.
    GossipBlock(String),
}

static RUNNING:      AtomicBool = AtomicBool::new(false);
static COMMANDS:     OnceLock<Mutex<Option<Sender<Command>>>> = OnceLock::new();
/// Inbound block hashes received from remote peers via Gossipsub.
/// Kotlin polls this with `P2PNode.pollGossip()`.
static GOSSIP_QUEUE: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn command_slot() -> &'static Mutex<Option<Sender<Command>>> {
    COMMANDS.get_or_init(|| Mutex::new(None))
}

fn gossip_queue() -> &'static Mutex<VecDeque<String>> {
    GOSSIP_QUEUE.get_or_init(|| Mutex::new(VecDeque::with_capacity(GOSSIP_QUEUE_CAP)))
}

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

/// Start a background dual-transport swarm on `listen_tcp` (TCP) and
/// `listen_quic` (QUIC/UDP).  Pass `0` for `listen_quic` to disable QUIC.
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

async fn run_swarm(rx: mpsc::Receiver<Command>, listen_tcp: u16, listen_quic: u16) {
    let keys        = libp2p::identity::Keypair::generate_ed25519();
    let peer_id     = PeerId::from(keys.public());
    let topic_blocks = gossipsub::IdentTopic::new(GOSSIP_BLOCKS);
    let topic_txs    = gossipsub::IdentTopic::new(GOSSIP_TXS);

    let mut gossip = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(keys.clone()),
        gossipsub::Config::default(),
    ).expect("valid gossipsub config");
    let _ = gossip.subscribe(&topic_blocks);
    let _ = gossip.subscribe(&topic_txs);

    let identify = identify::Behaviour::new(
        identify::Config::new(IDENTIFY_PROTO.to_string(), keys.public())
            .with_push_listen_addr_updates(true),
    );
    let mut kad = kad::Behaviour::new(peer_id, kad::store::MemoryStore::new(peer_id));
    kad.set_mode(Some(kad::Mode::Server));

    let mut swarm = libp2p::Swarm::new(
        make_transport(&keys),
        Behaviour { gossipsub: gossip, identify, kad },
        peer_id,
        SwarmConfig::with_tokio_executor(),
    );

    if let Ok(addr) = format!("/ip4/0.0.0.0/tcp/{listen_tcp}").parse() {
        if let Err(error) = swarm.listen_on(addr) {
            eprintln!("[p2p-runtime] TCP listen failed: {error}");
        }
    }
    if listen_quic > 0 {
        if let Ok(addr) = format!("/ip4/0.0.0.0/udp/{listen_quic}/quic-v1").parse() {
            if let Err(error) = swarm.listen_on(addr) {
                eprintln!("[p2p-runtime] QUIC listen failed: {error}");
            }
        }
    }
    eprintln!("[p2p-runtime] peer_id={peer_id}");

    let blocks_topic_hash = topic_blocks.hash();

    while RUNNING.load(Ordering::Acquire) {
        // Drain any pending commands before blocking on the swarm.
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Command::Dial(addr) => {
                    if let Err(error) = swarm.dial(addr.clone()) {
                        eprintln!("[p2p-runtime] dial {addr} failed: {error}");
                    }
                }
                Command::GossipBlock(hash) => {
                    match swarm
                        .behaviour_mut()
                        .gossipsub
                        .publish(topic_blocks.clone(), hash.as_bytes().to_vec())
                    {
                        Ok(_)  => eprintln!("[p2p-runtime] gossiped block {hash}"),
                        Err(e) => eprintln!("[p2p-runtime] gossip_block failed: {e}"),
                    }
                }
            }
        }

        tokio::select! {
            event = swarm.select_next_some() => {
                match event {
                    // ── Inbound Gossipsub block hash from a remote peer ──────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { message, .. }
                    )) => {
                        if message.topic == blocks_topic_hash {
                            if let Ok(hash) = std::str::from_utf8(&message.data) {
                                let mut q = gossip_queue()
                                    .lock()
                                    .expect("gossip queue poisoned");
                                // Drop oldest on overflow to keep the queue bounded.
                                if q.len() >= GOSSIP_QUEUE_CAP {
                                    q.pop_front();
                                }
                                q.push_back(hash.to_string());
                                eprintln!("[p2p-runtime] received block {hash}");
                            }
                        }
                    }
                    // ── New outbound connection: register with DHT ───────────────────────
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        if let libp2p::core::ConnectedPoint::Dialer { address, .. } = endpoint {
                            swarm.behaviour_mut().kad.add_address(&peer_id, address);
                        }
                        let _ = swarm.behaviour_mut().kad.bootstrap();
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
    }
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
    else {
        return false;
    };
    sender.send(Command::Dial(multiaddr)).is_ok()
}

/// Publish a solved block hash to all connected peers via Gossipsub.
/// Returns `false` if the swarm is not running or the channel is full.
pub fn gossip_block(hash: &str) -> bool {
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned()
    else {
        return false;
    };
    sender.send(Command::GossipBlock(hash.to_string())).is_ok()
}

/// Pop the next inbound block hash from the gossip queue, or `None` if empty.
///
/// The Android mining loop can call this to learn about competing solutions
/// that arrived while the solver was running, and skip re-solving a block that
/// peers have already won.
pub fn poll_gossip() -> Option<String> {
    gossip_queue()
        .lock()
        .expect("gossip queue poisoned")
        .pop_front()
}

// ── Tip cache public API ───────────────────────────────────────────────────────

/// Return the latest locally-cached chain tip as a JSON string, or an empty
/// string if no tip has been stored yet (i.e. no block has been accepted or
/// gossiped since start).
///
/// JSON format: `{"height":<u64>,"hash":"<hex>","difficulty":<u64>}`
///
/// Kotlin calls this before `fetchChainStatus(nodeUrl)` so that, when peers
/// are reachable, the mining loop never needs the cloud HTTP node for tip data.
pub fn fetch_tip() -> String {
    let cache = tip_cache().read().expect("tip cache read poisoned");
    if cache.hash.is_empty() {
        return String::new();
    }
    format!(
        r#"{{"height":{},"hash":"{}","difficulty":{}}}"#,
        cache.height, cache.hash, cache.difficulty,
    )
}

/// Update the local tip cache.  Call this after any block is accepted (by the
/// phone solver or received via gossip) so future `fetch_tip()` calls reflect
/// the latest known chain state without hitting the HTTP node.
///
/// Returns `true` if the height is strictly greater than the stored height
/// (i.e. the tip actually advanced).
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
