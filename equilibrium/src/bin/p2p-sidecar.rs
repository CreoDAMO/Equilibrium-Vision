// ── Equilibrium P2P Sidecar ────────────────────────────────────────────────────
//
// Bridges the TypeScript node's state to a real libp2p network.
//
// Protocols implemented:
//   1. Gossipsub — hash-only block and TX announcements
//   2. mDNS      — zero-config LAN peer discovery
//   3. Identify  — peers advertise their multiaddrs so Kademlia can route to them
//   4. Kademlia  — peer discovery without fixed seed nodes; bootstraps on every
//                  new connection; both mDNS and Identify feed its routing table
//   5. Light-node RR (/equilibrium/lightnode/1.0.0) — tip, headers, compact
//                  SMT proofs served peer-to-peer; no HTTP required
//   6. Sync RR   (/equilibrium/sync/1.0.0) — full block and TX body fetch over
//                  P2P; body gossip no longer requires an HTTP server
//
// Protocol (stdin/stdout newline-delimited JSON):
//
//   Inbound commands (TS → sidecar):
//     {"id":"<uuid>","method":"gossip_block","blockHash":"<hex64>"}
//     {"id":"<uuid>","method":"gossip_tx","txHash":"<hex64>"}
//     {"id":"<uuid>","method":"peers"}
//     {"id":"<uuid>","method":"connect","addr":"<multiaddr>"}
//     {"id":"<uuid>","method":"listen_addrs"}
//     {"id":"<uuid>","method":"query_peer","peerId":"<pid>","query":{...}}
//     {"id":"<uuid>","method":"lightnode_response","requestId":"<id>","ok":true,"data":{...}}
//     {"id":"<uuid>","method":"query_sync","peerId":"<pid>","query":{"kind":"block","params":{"hash":"..."}}}
//     {"id":"<uuid>","method":"sync_response","requestId":"<id>","ok":true,"data":{...}}
//
//   Outbound events (sidecar → TS):
//     {"event":"block","blockHash":"<hex64>","peerId":"..."}
//     {"event":"tx","txHash":"<hex64>","peerId":"..."}
//     {"event":"peer_connected","peerId":"..."}
//     {"event":"peer_disconnected","peerId":"..."}
//     {"event":"peer_discovered","peerId":"...","addrs":["<multiaddr>"]}
//     {"event":"peer_identified","peerId":"..."}
//     {"event":"lightnode_request","requestId":"<uuid>","fromPeerId":"...","query":{...}}
//     {"event":"sync_request","requestId":"<uuid>","fromPeerId":"...","query":{...}}
//
// Build:   cargo build --release --bin p2p-sidecar  (from equilibrium/)
// Config:  P2P_PORT (default 9000), P2P_QUIC_PORT (default P2P_PORT + 1),
//          P2P_BOOTSTRAP (comma-separated multiaddrs)
//
// All log output goes to stderr so it never pollutes the JSON stdout stream.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, Write};
use std::str::FromStr;
use std::time::Duration;

use libp2p::{
    core::{muxing::StreamMuxerBox, transport::OrTransport},
    gossipsub, identify, kad, mdns, noise, quic, request_response,
    swarm::{Config as SwarmConfig, NetworkBehaviour, SwarmEvent},
    tcp, yamux,
    core::upgrade::Version,
    identity, Multiaddr, PeerId, StreamProtocol, Transport,
};
use futures::future::Either;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

// ── Protocol IDs ───────────────────────────────────────────────────────────────

const TOPIC_BLOCKS:       &str = "equilibrium/blocks/1.0.0";
const TOPIC_TXS:          &str = "equilibrium/txs/1.0.0";
/// Full block body gossip — phones publish after a successful HTTP submit so
/// desktop nodes (and other phones) can accept the block body without a
/// separate sync RR fetch or cloud HTTP request.
const TOPIC_BLOCK_BODIES: &str = "equilibrium/block-bodies/1.0.0";
const LIGHTNODE_PROTO: &str = "/equilibrium/lightnode/1.0.0";
const SYNC_PROTO:      &str = "/equilibrium/sync/1.0.0";
const IDENTIFY_PROTO:  &str = "/equilibrium/id/1.0.0";

// ── Message types ──────────────────────────────────────────────────────────────

/// Light-node request: tip, headers, compact SMT proofs.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct LightnodeReq {
    id:     String,
    /// "tip" | "headers" | "sync" | "proof_account" | "proof_utxo"
    kind:   String,
    #[serde(default)]
    params: Value,
}

/// Light-node response.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct LightnodeResp {
    id:    String,
    ok:    bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data:  Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Sync request: full block or TX body (not proofs — actual block data).
#[derive(Serialize, Deserialize, Debug, Clone)]
struct SyncReq {
    id:     String,
    /// "block" | "blocks" | "tx" | "txs"
    kind:   String,
    #[serde(default)]
    params: Value,
}

/// Sync response: full block/TX JSON or an error.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct SyncResp {
    id:    String,
    ok:    bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data:  Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Combined NetworkBehaviour ──────────────────────────────────────────────────

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns:      mdns::tokio::Behaviour,
    /// Light-node: compact proof queries, no HTTP required.
    lightnode: request_response::json::Behaviour<LightnodeReq, LightnodeResp>,
    /// Sync: full block/TX body fetch, eliminating HTTP as a body source.
    sync:      request_response::json::Behaviour<SyncReq, SyncResp>,
    /// Identify: advertise listen multiaddrs so Kademlia can route to us.
    identify:  identify::Behaviour,
    /// Kademlia: WAN peer discovery without fixed bootstrap servers.
    kad:       kad::Behaviour<kad::store::MemoryStore>,
}

// ── Command from TypeScript ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Command {
    #[serde(default)]
    id:         String,
    method:     String,
    #[serde(rename = "blockHash")]
    block_hash: Option<String>,
    #[serde(rename = "txHash")]
    tx_hash:    Option<String>,
    addr:       Option<String>,
    #[serde(rename = "peerId")]
    peer_id:    Option<String>,
    /// Alias accepted by the test suite alongside `blockHash`.
    hash:       Option<String>,
    query:      Option<Value>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    ok:         Option<bool>,
    data:       Option<Value>,
    error:      Option<String>,
}

// ── Pending response maps ──────────────────────────────────────────────────────

/// Outbound RR request_id → TS correlation id (for routing the response back).
type OutboundLN   = HashMap<request_response::OutboundRequestId, String>;
type InboundLN    = HashMap<String, request_response::ResponseChannel<LightnodeResp>>;
type OutboundSync = HashMap<request_response::OutboundRequestId, String>;
type InboundSync  = HashMap<String, request_response::ResponseChannel<SyncResp>>;

// ── Helpers ────────────────────────────────────────────────────────────────────

fn ok_resp(id: &str) -> Value { serde_json::json!({ "id": id, "ok": true }) }
fn err_resp(id: &str, msg: impl std::fmt::Display) -> Value {
    serde_json::json!({ "id": id, "ok": false, "error": msg.to_string() })
}
fn emit(stdout: &std::io::Stdout, val: &Value) {
    let mut out = stdout.lock();
    let _ = writeln!(out, "{}", serde_json::to_string(val).unwrap_or_default());
    let _ = out.flush();
}

// ── Main ───────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("P2P_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9000);
    let quic_port: u16 = std::env::var("P2P_QUIC_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| port.saturating_add(1));

    let bootstrap_peers: Vec<String> = std::env::var("P2P_BOOTSTRAP")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .collect();

    // ── Identity ───────────────────────────────────────────────────────────────
    let id_keys = identity::Keypair::generate_ed25519();
    let local_peer_id = PeerId::from(id_keys.public());
    eprintln!("[p2p-sidecar] peer_id={local_peer_id}");

    // ── Transport: QUIC + TCP ───────────────────────────────────────────────────
    // QUIC is preferred for mobile/NAT-friendly peers; TCP remains available
    // for existing nodes and networks that block UDP.
    let tcp_transport = tcp::tokio::Transport::default()
        .upgrade(Version::V1)
        .authenticate(noise::Config::new(&id_keys)?)
        .multiplex(yamux::Config::default());
    let quic_transport = quic::tokio::Transport::new(quic::Config::new(&id_keys));
    let transport = OrTransport::new(quic_transport, tcp_transport)
        .map(|output, _| match output {
            Either::Left((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
            Either::Right((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
        })
        .boxed();

    // ── Gossipsub ──────────────────────────────────────────────────────────────
    let gossipsub_cfg = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(1))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .build()
        .expect("valid gossipsub config");
    let mut gossipsub_beh = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(id_keys.clone()),
        gossipsub_cfg,
    )?;
    let topic_blocks = gossipsub::IdentTopic::new(TOPIC_BLOCKS);
    let topic_txs    = gossipsub::IdentTopic::new(TOPIC_TXS);
    let topic_bodies = gossipsub::IdentTopic::new(TOPIC_BLOCK_BODIES);
    gossipsub_beh.subscribe(&topic_blocks)?;
    gossipsub_beh.subscribe(&topic_txs)?;
    gossipsub_beh.subscribe(&topic_bodies)?;

    // ── mDNS — zero-config LAN peer discovery ─────────────────────────────────
    let mdns_beh = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;

    // ── Light-node request-response ────────────────────────────────────────────
    let lightnode_beh = request_response::json::Behaviour::<LightnodeReq, LightnodeResp>::new(
        [(StreamProtocol::new(LIGHTNODE_PROTO), request_response::ProtocolSupport::Full)],
        request_response::Config::default(),
    );

    // ── Sync request-response (full block/TX bodies over P2P) ─────────────────
    // Allows any peer to fetch block or TX bodies from us directly, without
    // routing through the TypeScript HTTP server.
    let sync_beh = request_response::json::Behaviour::<SyncReq, SyncResp>::new(
        [(StreamProtocol::new(SYNC_PROTO), request_response::ProtocolSupport::Full)],
        request_response::Config::default().with_max_concurrent_streams(64),
    );

    // ── Identify — advertise our multiaddrs to connected peers ─────────────────
    // Without Identify, remote peers only know the address they dialed and
    // cannot propagate our listen addresses through the Kademlia DHT.
    let identify_beh = identify::Behaviour::new(
        identify::Config::new(IDENTIFY_PROTO.to_string(), id_keys.public())
            .with_push_listen_addr_updates(true),
    );

    // ── Kademlia DHT — peer discovery without permanent seed nodes ─────────────
    // Phones bootstrap from their first contact (mDNS or QR/NFC), then the
    // DHT sustains the mesh. kad::Mode::Server means we participate in routing;
    // constrained devices can use Client mode to query only.
    let mut kad_beh = kad::Behaviour::new(
        local_peer_id,
        kad::store::MemoryStore::new(local_peer_id),
    );
    kad_beh.set_mode(Some(kad::Mode::Server));

    // ── Assemble swarm ─────────────────────────────────────────────────────────
    let behaviour = Behaviour {
        gossipsub: gossipsub_beh,
        mdns:      mdns_beh,
        lightnode: lightnode_beh,
        sync:      sync_beh,
        identify:  identify_beh,
        kad:       kad_beh,
    };

    let mut swarm = libp2p::Swarm::new(
        transport,
        behaviour,
        local_peer_id,
        SwarmConfig::with_tokio_executor()
            .with_idle_connection_timeout(Duration::from_secs(60)),
    );

    // ── Listen ─────────────────────────────────────────────────────────────────
    let listen_addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{port}").parse()?;
    swarm.listen_on(listen_addr)?;
    let quic_addr: Multiaddr = format!("/ip4/0.0.0.0/udp/{quic_port}/quic-v1").parse()?;
    swarm.listen_on(quic_addr)?;

    // ── Bootstrap dial ─────────────────────────────────────────────────────────
    for addr_str in &bootstrap_peers {
        if let Ok(ma) = Multiaddr::from_str(addr_str) {
            match swarm.dial(ma.clone()) {
                Ok(_)  => eprintln!("[p2p-sidecar] dialing bootstrap {addr_str}"),
                Err(e) => eprintln!("[p2p-sidecar] dial {addr_str} failed: {e}"),
            }
        }
    }

    // ── Stdin reader — blocking I/O in its own OS thread ──────────────────────
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<String>(64);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if cmd_tx.blocking_send(l).is_err() { break; }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let stdout            = std::io::stdout();
    let mut connected:    HashSet<PeerId>    = HashSet::new();
    let mut ln_out:       OutboundLN         = HashMap::new();
    let mut ln_in:        InboundLN          = HashMap::new();
    let mut sync_out:     OutboundSync       = HashMap::new();
    let mut sync_in:      InboundSync        = HashMap::new();
    // Buffer for gossip block hashes received from peers.  Drained by the
    // `poll_gossip` RPC so the test suite can pull-check received messages.
    let mut gossip_queue: VecDeque<String>   = VecDeque::new();

    // ── Event loop ─────────────────────────────────────────────────────────────
    loop {
        tokio::select! {
            // ── Inbound command from TypeScript ────────────────────────────────
            Some(line) = cmd_rx.recv() => {
                let resp = handle_command(
                    &line, &mut swarm,
                    local_peer_id,
                    &topic_blocks, &topic_txs, &topic_bodies,
                    &mut ln_out, &mut ln_in,
                    &mut sync_out, &mut sync_in,
                    &mut gossip_queue,
                );
                emit(&stdout, &resp);
            }

            // ── libp2p swarm events ────────────────────────────────────────────
            event = swarm.select_next_some() => {
                match event {

                    // ── Gossipsub ─────────────────────────────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(
                        gossipsub::Event::Message { propagation_source, message, .. }
                    )) => {
                        let topic   = message.topic.as_str().to_string();
                        let payload = std::str::from_utf8(&message.data)
                            .unwrap_or("").trim().to_string();
                        let peer_id = propagation_source.to_string();
                        // Buffer block hashes so `poll_gossip` can drain them.
                        if topic == TOPIC_BLOCKS && !payload.is_empty() {
                            gossip_queue.push_back(payload.clone());
                        }
                        let evt = if topic == TOPIC_BLOCKS {
                            serde_json::json!({ "event": "block", "blockHash": payload, "peerId": peer_id })
                        } else if topic == TOPIC_BLOCK_BODIES {
                            // Block body JSON — parse it so the TS layer receives a
                            // structured object rather than a raw string.
                            let body = serde_json::from_str::<serde_json::Value>(&payload)
                                .unwrap_or(serde_json::Value::Null);
                            serde_json::json!({ "event": "block_body", "body": body, "peerId": peer_id })
                        } else {
                            serde_json::json!({ "event": "tx", "txHash": payload, "peerId": peer_id })
                        };
                        emit(&stdout, &evt);
                    }

                    // ── mDNS peer discovery ────────────────────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Mdns(
                        mdns::Event::Discovered(list)
                    )) => {
                        for (peer_id, addr) in list {
                            eprintln!("[p2p-sidecar] mDNS discovered {peer_id} @ {addr}");
                            // Auto-dial and seed Kademlia routing table
                            let _ = swarm.dial(addr.clone());
                            swarm.behaviour_mut().kad.add_address(&peer_id, addr.clone());
                            emit(&stdout, &serde_json::json!({
                                "event":  "peer_discovered",
                                "peerId": peer_id.to_string(),
                                "addrs":  [addr.to_string()],
                            }));
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Expired(list))) => {
                        for (peer_id, _) in list {
                            eprintln!("[p2p-sidecar] mDNS expired {peer_id}");
                        }
                    }

                    // ── Identify ──────────────────────────────────────────────
                    // When a peer tells us their listen addresses, we add them to
                    // Kademlia so the DHT can route to them even across NATs.
                    SwarmEvent::Behaviour(BehaviourEvent::Identify(
                        identify::Event::Received { peer_id, info, .. }
                    )) => {
                        eprintln!(
                            "[p2p-sidecar] identify: {peer_id} listens on {} addr(s)",
                            info.listen_addrs.len()
                        );
                        for addr in info.listen_addrs {
                            swarm.behaviour_mut().kad.add_address(&peer_id, addr);
                        }
                        // Notify TS so it can update the peer's known addresses
                        emit(&stdout, &serde_json::json!({
                            "event":  "peer_identified",
                            "peerId": peer_id.to_string(),
                        }));
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Identify(_)) => {}

                    // ── Kademlia ──────────────────────────────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Kad(
                        kad::Event::RoutingUpdated { peer, .. }
                    )) => {
                        eprintln!("[p2p-sidecar] kad: routing table updated for {peer}");
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Kad(
                        kad::Event::OutboundQueryProgressed {
                            result: kad::QueryResult::Bootstrap(Ok(
                                kad::BootstrapOk { num_remaining, .. }
                            )),
                            ..
                        }
                    )) => {
                        if num_remaining == 0 {
                            eprintln!("[p2p-sidecar] kad: bootstrap complete");
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Kad(_)) => {}

                    // ── Light-node RR: inbound request ────────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::Message {
                            peer,
                            connection_id: _,
                            message: request_response::Message::Request {
                                request_id, request, channel
                            },
                        }
                    )) => {
                        let req_uuid = uuid_v4();
                        ln_in.insert(req_uuid.clone(), channel);
                        emit(&stdout, &serde_json::json!({
                            "event":      "lightnode_request",
                            "requestId":  req_uuid,
                            "fromPeerId": peer.to_string(),
                            "query": {
                                "kind":   request.kind,
                                "params": request.params,
                            },
                        }));
                        let _ = request_id;
                    }

                    // ── Light-node RR: outbound response ──────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::Message {
                            connection_id: _,
                            message: request_response::Message::Response {
                                request_id, response
                            },
                            ..
                        }
                    )) => {
                        if let Some(corr) = ln_out.remove(&request_id) {
                            let out = if response.ok {
                                serde_json::json!({ "id": corr, "ok": true, "data": response.data })
                            } else {
                                serde_json::json!({ "id": corr, "ok": false, "error": response.error.unwrap_or_default() })
                            };
                            emit(&stdout, &out);
                        }
                    }

                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::OutboundFailure { request_id, error, .. }
                    )) => {
                        if let Some(corr) = ln_out.remove(&request_id) {
                            emit(&stdout, &err_resp(&corr, error));
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::InboundFailure { .. }
                    )) => {}
                    SwarmEvent::Behaviour(BehaviourEvent::Lightnode(
                        request_response::Event::ResponseSent { .. }
                    )) => {}

                    // ── Sync RR: inbound request ───────────────────────────────
                    // A remote peer wants a full block or TX body. Forward the
                    // request to TS which will serve it from its local store.
                    SwarmEvent::Behaviour(BehaviourEvent::Sync(
                        request_response::Event::Message {
                            peer,
                            connection_id: _,
                            message: request_response::Message::Request {
                                request_id, request, channel
                            },
                        }
                    )) => {
                        let req_uuid = uuid_v4();
                        sync_in.insert(req_uuid.clone(), channel);
                        emit(&stdout, &serde_json::json!({
                            "event":      "sync_request",
                            "requestId":  req_uuid,
                            "fromPeerId": peer.to_string(),
                            "query": {
                                "kind":   request.kind,
                                "params": request.params,
                            },
                        }));
                        let _ = request_id;
                    }

                    // ── Sync RR: outbound response received ────────────────────
                    SwarmEvent::Behaviour(BehaviourEvent::Sync(
                        request_response::Event::Message {
                            connection_id: _,
                            message: request_response::Message::Response {
                                request_id, response
                            },
                            ..
                        }
                    )) => {
                        if let Some(corr) = sync_out.remove(&request_id) {
                            let out = if response.ok {
                                serde_json::json!({ "id": corr, "ok": true, "data": response.data })
                            } else {
                                serde_json::json!({ "id": corr, "ok": false, "error": response.error.unwrap_or_default() })
                            };
                            emit(&stdout, &out);
                        }
                    }

                    SwarmEvent::Behaviour(BehaviourEvent::Sync(
                        request_response::Event::OutboundFailure { request_id, error, .. }
                    )) => {
                        if let Some(corr) = sync_out.remove(&request_id) {
                            emit(&stdout, &err_resp(&corr, error));
                        }
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Sync(
                        request_response::Event::InboundFailure { .. }
                    )) => {}
                    SwarmEvent::Behaviour(BehaviourEvent::Sync(
                        request_response::Event::ResponseSent { .. }
                    )) => {}

                    // ── Connection lifecycle ───────────────────────────────────
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                        connected.insert(peer_id);

                        // Seed Kademlia with the peer's dialed address so the
                        // routing table can propagate it through the DHT.
                        if let libp2p::core::ConnectedPoint::Dialer { address, .. } = endpoint {
                            swarm.behaviour_mut().kad.add_address(&peer_id, address);
                        }

                        // Bootstrap Kademlia on every new connection — this
                        // expands our view of the network with zero seed nodes.
                        let _ = swarm.behaviour_mut().kad.bootstrap();

                        emit(&stdout, &serde_json::json!({
                            "event":  "peer_connected",
                            "peerId": peer_id.to_string()
                        }));
                        eprintln!("[p2p-sidecar] connected: {peer_id}");
                    }

                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        connected.remove(&peer_id);
                        emit(&stdout, &serde_json::json!({
                            "event":  "peer_disconnected",
                            "peerId": peer_id.to_string()
                        }));
                    }

                    SwarmEvent::NewListenAddr { address, .. } => {
                        eprintln!("[p2p-sidecar] Listening on {address}");
                        emit(&stdout, &serde_json::json!({
                            "event": "listen_addr",
                            "addr": address.to_string(),
                        }));
                    }

                    _ => {}
                }
            }
        }
    }
}

// ── Command handler ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn handle_command(
    line:          &str,
    swarm:         &mut libp2p::Swarm<Behaviour>,
    local_peer_id: PeerId,
    topic_blocks:  &gossipsub::IdentTopic,
    topic_txs:     &gossipsub::IdentTopic,
    topic_bodies:  &gossipsub::IdentTopic,
    ln_out:        &mut OutboundLN,
    ln_in:         &mut InboundLN,
    sync_out:      &mut OutboundSync,
    sync_in:       &mut InboundSync,
    gossip_queue:  &mut VecDeque<String>,
) -> Value {
    let cmd: Command = match serde_json::from_str(line) {
        Ok(c)  => c,
        Err(e) => return serde_json::json!({ "id": "", "ok": false, "error": format!("parse error: {e}") }),
    };
    let id = cmd.id.as_str();

    match cmd.method.as_str() {

        // Accept both `blockHash` (documented protocol) and `hash` (test alias).
        "gossip_block" => {
            let hash = cmd.block_hash.or(cmd.hash).unwrap_or_default();
            match swarm.behaviour_mut().gossipsub.publish(topic_blocks.clone(), hash.as_bytes().to_vec()) {
                Ok(_)  => ok_resp(id),
                Err(e) => err_resp(id, e),
            }
        }

        // Return this node's peer ID.
        "peer_id" => {
            serde_json::json!({ "id": id, "ok": true, "peer_id": local_peer_id.to_string() })
        }

        // Drain one buffered gossip block hash (push-based sidecar; tests use this to poll).
        "poll_gossip" => {
            match gossip_queue.pop_front() {
                Some(h) => serde_json::json!({ "id": id, "ok": true, "hash": h }),
                None    => serde_json::json!({ "id": id, "ok": true, "hash": serde_json::Value::Null }),
            }
        }

        // No-op: all topics are subscribed at startup.
        "subscribe" => ok_resp(id),

        "gossip_tx" => {
            let hash = cmd.tx_hash.unwrap_or_default();
            match swarm.behaviour_mut().gossipsub.publish(topic_txs.clone(), hash.as_bytes().to_vec()) {
                Ok(_)  => ok_resp(id),
                Err(e) => err_resp(id, e),
            }
        }

        // Publish a full block body JSON so mobile peers can store and serve it
        // without needing an HTTP node.  `data` carries the block body object.
        "gossip_block_body" => {
            let body = cmd.data.unwrap_or(serde_json::Value::Null);
            let json = serde_json::to_string(&body).unwrap_or_default();
            match swarm.behaviour_mut().gossipsub.publish(topic_bodies.clone(), json.into_bytes()) {
                Ok(_)  => ok_resp(id),
                Err(e) => err_resp(id, e),
            }
        }

        "peers" => {
            let peers: Vec<Value> = swarm
                .behaviour()
                .gossipsub
                .all_peers()
                .map(|(pid, _)| serde_json::json!({ "peerId": pid.to_string() }))
                .collect();
            serde_json::json!({ "id": id, "ok": true, "peers": peers })
        }

        "connect" => {
            let addr_str = cmd.addr.unwrap_or_default();
            match Multiaddr::from_str(&addr_str) {
                Ok(ma) => match swarm.dial(ma) {
                    Ok(_)  => ok_resp(id),
                    Err(e) => err_resp(id, e),
                },
                Err(e) => err_resp(id, format!("invalid multiaddr: {e}")),
            }
        }

        "listen_addrs" => {
            let addrs: Vec<String> = swarm.listeners().map(|a| a.to_string()).collect();
            serde_json::json!({ "id": id, "ok": true, "addrs": addrs })
        }

        // ── Light-node: TS → request data from a remote peer ──────────────────
        "query_peer" => {
            let peer_id_str = cmd.peer_id.unwrap_or_default();
            let query       = cmd.query.unwrap_or(Value::Null);
            let Ok(peer_id) = peer_id_str.parse::<PeerId>() else {
                return err_resp(id, format!("invalid PeerId: {peer_id_str}"));
            };
            let req = LightnodeReq {
                id:     id.to_string(),
                kind:   query.get("kind").and_then(|v| v.as_str()).unwrap_or("tip").to_string(),
                params: query.get("params").cloned().unwrap_or(Value::Null),
            };
            let outbound_id = swarm.behaviour_mut().lightnode.send_request(&peer_id, req);
            ln_out.insert(outbound_id, id.to_string());
            // Response arrives as a SwarmEvent; return a sentinel now.
            serde_json::json!({ "id": id, "ok": true, "pending": true })
        }

        // ── Light-node: TS responds to an inbound light-node query ─────────────
        "lightnode_response" => {
            let req_id = cmd.request_id.unwrap_or_default();
            let Some(channel) = ln_in.remove(&req_id) else {
                return err_resp(id, format!("unknown lightnode requestId: {req_id}"));
            };
            let resp = LightnodeResp {
                id:    req_id.clone(),
                ok:    cmd.ok.unwrap_or(true),
                data:  cmd.data,
                error: cmd.error,
            };
            match swarm.behaviour_mut().lightnode.send_response(channel, resp) {
                Ok(_)  => ok_resp(id),
                Err(_) => err_resp(id, "lightnode channel closed before response could be sent"),
            }
        }

        // ── Sync: TS → request full block or TX body from a remote peer ────────
        "query_sync" => {
            let peer_id_str = cmd.peer_id.unwrap_or_default();
            let query       = cmd.query.unwrap_or(Value::Null);
            let Ok(peer_id) = peer_id_str.parse::<PeerId>() else {
                return err_resp(id, format!("invalid PeerId: {peer_id_str}"));
            };
            let req = SyncReq {
                id:     id.to_string(),
                kind:   query.get("kind").and_then(|v| v.as_str()).unwrap_or("block").to_string(),
                params: query.get("params").cloned().unwrap_or(Value::Null),
            };
            let outbound_id = swarm.behaviour_mut().sync.send_request(&peer_id, req);
            sync_out.insert(outbound_id, id.to_string());
            serde_json::json!({ "id": id, "ok": true, "pending": true })
        }

        // ── Sync: TS responds to an inbound body sync request ─────────────────
        "sync_response" => {
            let req_id = cmd.request_id.unwrap_or_default();
            let Some(channel) = sync_in.remove(&req_id) else {
                return err_resp(id, format!("unknown sync requestId: {req_id}"));
            };
            let resp = SyncResp {
                id:    req_id.clone(),
                ok:    cmd.ok.unwrap_or(true),
                data:  cmd.data,
                error: cmd.error,
            };
            match swarm.behaviour_mut().sync.send_response(channel, resp) {
                Ok(_)  => ok_resp(id),
                Err(_) => err_resp(id, "sync channel closed before response could be sent"),
            }
        }

        other => err_resp(id, format!("unknown method: {other}")),
    }
}

// ── UUID v4 (no external crate) ────────────────────────────────────────────────

fn uuid_v4() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let c = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let hi = t.wrapping_mul(6364136223846793005u64).wrapping_add(c);
    format!("{hi:016x}{c:016x}")
}

use futures::StreamExt as _;
