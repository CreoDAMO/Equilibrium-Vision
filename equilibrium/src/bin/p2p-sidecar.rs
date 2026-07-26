// ── Equilibrium P2P Sidecar ────────────────────────────────────────────────────
//
// Bridges the TypeScript node's simulated gossip to a real libp2p Gossipsub
// network. The TypeScript node spawns this binary and communicates via
// newline-delimited JSON on stdin/stdout — the same pattern as consensus-api.
//
// Protocol:
//   Inbound commands (from TS → stdin):
//     {"method":"gossip_block","blockHash":"<hex64>"}
//     {"method":"gossip_tx","txHash":"<hex64>"}
//     {"method":"peers"}
//     {"method":"connect","addr":"<multiaddr>"}
//     {"method":"listen_addrs"}
//
//   Outbound responses (stdout → TS):
//     {"ok":true}
//     {"ok":true,"peers":[{"peerId":"...","addr":"..."},...]}
//     {"ok":true,"addrs":["<multiaddr>,...]}
//
//   Unsolicited events (stdout → TS):
//     {"event":"block","blockHash":"<hex64>","peerId":"..."}
//     {"event":"tx","txHash":"<hex64>","peerId":"..."}
//     {"event":"peer_connected","peerId":"..."}
//     {"event":"peer_disconnected","peerId":"..."}
//
// Build:   cargo build --release --bin p2p-sidecar
// Config:  P2P_PORT (default 9000), P2P_BOOTSTRAP (comma-separated multiaddrs)
//
// Note: All log output goes to stderr so it doesn't pollute the JSON stdout stream.

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::str::FromStr;

use libp2p::{
    gossipsub, identity, noise,
    swarm::{Config as SwarmConfig, SwarmEvent},
    tcp, yamux,
    Multiaddr, PeerId, Transport,
    core::upgrade::Version,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

// ── Topics ─────────────────────────────────────────────────────────────────────

const TOPIC_BLOCKS: &str = "equilibrium/blocks/1.0.0";
const TOPIC_TXS:    &str = "equilibrium/txs/1.0.0";

// ── Command / response shapes ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct Command {
    method: String,
    #[serde(rename = "blockHash")]
    block_hash: Option<String>,
    #[serde(rename = "txHash")]
    tx_hash:    Option<String>,
    addr:       Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Ok      { ok: bool },
    Peers   { ok: bool, peers: Vec<PeerInfo> },
    Addrs   { ok: bool, addrs: Vec<String> },
    Err     { ok: bool, error: String },
}

#[derive(Serialize)]
struct PeerInfo {
    #[serde(rename = "peerId")]
    peer_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    event:   &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_hash: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tx_hash:    Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer_id:    Option<String>,
}

// ── Main ───────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("P2P_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9000);

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

    // ── Transport: TCP + Noise + Yamux ─────────────────────────────────────────
    let transport = tcp::tokio::Transport::default()
        .upgrade(Version::V1)
        .authenticate(noise::Config::new(&id_keys)?)
        .multiplex(yamux::Config::default())
        .boxed();

    // ── Gossipsub ──────────────────────────────────────────────────────────────
    let gossipsub_cfg = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(std::time::Duration::from_secs(1))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .build()
        .expect("valid gossipsub config");

    let mut behaviour = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(id_keys),
        gossipsub_cfg,
    )?;

    // Subscribe to both topics
    let topic_blocks = gossipsub::IdentTopic::new(TOPIC_BLOCKS);
    let topic_txs    = gossipsub::IdentTopic::new(TOPIC_TXS);
    behaviour.subscribe(&topic_blocks)?;
    behaviour.subscribe(&topic_txs)?;

    let mut swarm = libp2p::Swarm::new(
        transport,
        behaviour,
        local_peer_id,
        SwarmConfig::with_tokio_executor(),
    );

    // ── Listen ─────────────────────────────────────────────────────────────────
    let listen_addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{port}").parse()?;
    swarm.listen_on(listen_addr)?;

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    for addr_str in &bootstrap_peers {
        if let Ok(ma) = Multiaddr::from_str(addr_str) {
            if let Err(e) = swarm.dial(ma.clone()) {
                eprintln!("[p2p-sidecar] dial {addr_str} failed: {e}");
            } else {
                eprintln!("[p2p-sidecar] dialing bootstrap {addr_str}");
            }
        }
    }

    // ── Channels: stdin commands → swarm task ──────────────────────────────────
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<String>(64);

    // Spawn a task to read stdin lines and push into the channel
    tokio::spawn(async move {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if cmd_tx.send(l).await.is_err() { break; }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let stdout = std::io::stdout();
    let mut connected: HashSet<PeerId> = HashSet::new();

    // ── Event loop ─────────────────────────────────────────────────────────────
    loop {
        tokio::select! {
            // ── Incoming command from TS node ──────────────────────────────────
            Some(line) = cmd_rx.recv() => {
                let resp = handle_command(&line, &mut swarm, &topic_blocks, &topic_txs);
                let mut out = stdout.lock();
                let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap_or_default());
                let _ = out.flush();
            }

            // ── libp2p swarm events ────────────────────────────────────────────
            event = swarm.next_event() => {
                match event {
                    SwarmEvent::Behaviour(gossipsub::Event::Message {
                        propagation_source: peer_id,
                        message,
                        ..
                    }) => {
                        let topic_str = message.topic.as_str();
                        let payload = std::str::from_utf8(&message.data)
                            .unwrap_or("")
                            .trim()
                            .to_string();

                        let evt: Value = if topic_str == TOPIC_BLOCKS {
                            serde_json::json!({
                                "event": "block",
                                "blockHash": payload,
                                "peerId": peer_id.to_string()
                            })
                        } else {
                            serde_json::json!({
                                "event": "tx",
                                "txHash": payload,
                                "peerId": peer_id.to_string()
                            })
                        };

                        let mut out = stdout.lock();
                        let _ = writeln!(out, "{}", serde_json::to_string(&evt).unwrap_or_default());
                        let _ = out.flush();
                    }

                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        connected.insert(peer_id);
                        let evt = serde_json::json!({
                            "event": "peer_connected",
                            "peerId": peer_id.to_string()
                        });
                        let mut out = stdout.lock();
                        let _ = writeln!(out, "{}", serde_json::to_string(&evt).unwrap_or_default());
                        let _ = out.flush();
                        eprintln!("[p2p-sidecar] peer connected: {peer_id}");
                    }

                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        connected.remove(&peer_id);
                        let evt = serde_json::json!({
                            "event": "peer_disconnected",
                            "peerId": peer_id.to_string()
                        });
                        let mut out = stdout.lock();
                        let _ = writeln!(out, "{}", serde_json::to_string(&evt).unwrap_or_default());
                        let _ = out.flush();
                    }

                    SwarmEvent::NewListenAddr { address, .. } => {
                        eprintln!("[p2p-sidecar] listening on {address}");
                    }

                    _ => {}
                }
            }
        }
    }
}

fn handle_command(
    line: &str,
    swarm: &mut libp2p::Swarm<gossipsub::Behaviour>,
    topic_blocks: &gossipsub::IdentTopic,
    topic_txs: &gossipsub::IdentTopic,
) -> Value {
    let cmd: Command = match serde_json::from_str(line) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("parse error: {e}") }),
    };

    match cmd.method.as_str() {
        "gossip_block" => {
            let hash = cmd.block_hash.unwrap_or_default();
            match swarm.behaviour_mut().publish(topic_blocks.clone(), hash.as_bytes().to_vec()) {
                Ok(_)  => serde_json::json!({ "ok": true }),
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
            }
        }

        "gossip_tx" => {
            let hash = cmd.tx_hash.unwrap_or_default();
            match swarm.behaviour_mut().publish(topic_txs.clone(), hash.as_bytes().to_vec()) {
                Ok(_)  => serde_json::json!({ "ok": true }),
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
            }
        }

        "peers" => {
            let peers: Vec<Value> = swarm
                .behaviour()
                .all_peers()
                .map(|(id, _)| serde_json::json!({ "peerId": id.to_string() }))
                .collect();
            serde_json::json!({ "ok": true, "peers": peers })
        }

        "connect" => {
            let addr_str = cmd.addr.unwrap_or_default();
            match Multiaddr::from_str(&addr_str) {
                Ok(ma) => match swarm.dial(ma) {
                    Ok(_)  => serde_json::json!({ "ok": true }),
                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                },
                Err(e) => serde_json::json!({ "ok": false, "error": format!("invalid multiaddr: {e}") }),
            }
        }

        "listen_addrs" => {
            let addrs: Vec<String> = swarm
                .listeners()
                .map(|a| a.to_string())
                .collect();
            serde_json::json!({ "ok": true, "addrs": addrs })
        }

        other => serde_json::json!({ "ok": false, "error": format!("unknown method: {other}") }),
    }
}

// ── Swarm extension trait for event polling ────────────────────────────────────

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

struct NextEvent<'a, TBehaviour: libp2p::swarm::NetworkBehaviour>(
    &'a mut libp2p::Swarm<TBehaviour>,
);

impl<TBehaviour: libp2p::swarm::NetworkBehaviour> Future for NextEvent<'_, TBehaviour> {
    type Output = SwarmEvent<TBehaviour::ToSwarm>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(self.get_mut().0).poll_next_unpin(cx)
            .map(|opt| opt.expect("swarm stream never ends"))
    }
}

trait SwarmExt<TBehaviour: libp2p::swarm::NetworkBehaviour> {
    fn next_event(&mut self) -> NextEvent<'_, TBehaviour>;
}

impl<TBehaviour: libp2p::swarm::NetworkBehaviour> SwarmExt<TBehaviour> for libp2p::Swarm<TBehaviour> {
    fn next_event(&mut self) -> NextEvent<'_, TBehaviour> {
        NextEvent(self)
    }
}

use futures::StreamExt as _;
