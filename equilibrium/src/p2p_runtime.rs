//! In-process libp2p runtime for mobile and embedded nodes.
//!
//! The desktop sidecar remains the richer JSON bridge used by the TypeScript
//! node.  This module deliberately has no stdin/stdout or HTTP dependency: an
//! Android/iOS host can start the swarm in its own process and feed it a
//! first-contact multiaddr directly.

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
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
        Mutex, OnceLock,
    },
    thread,
};

const GOSSIP_BLOCKS: &str = "equilibrium/blocks/1.0.0";
const GOSSIP_TXS: &str = "equilibrium/txs/1.0.0";
const IDENTIFY_PROTO: &str = "/equilibrium/id/1.0.0";

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    identify: identify::Behaviour,
    kad: kad::Behaviour<kad::store::MemoryStore>,
}

enum Command {
    Dial(Multiaddr),
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static COMMANDS: OnceLock<Mutex<Option<Sender<Command>>>> = OnceLock::new();

fn command_slot() -> &'static Mutex<Option<Sender<Command>>> {
    COMMANDS.get_or_init(|| Mutex::new(None))
}

fn make_transport(keys: &libp2p::identity::Keypair) -> Boxed<(PeerId, StreamMuxerBox)> {
    let quic_transport = libp2p::quic::tokio::Transport::new(libp2p::quic::Config::new(keys));
    let tcp_transport = tcp::tokio::Transport::default()
        .upgrade(Version::V1)
        .authenticate(noise::Config::new(keys).expect("valid noise key"))
        .multiplex(yamux::Config::default());

    OrTransport::new(quic_transport, tcp_transport)
        .map(|output, _| match output {
            Either::Left((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
            Either::Right((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
        })
        .boxed()
}

/// Start a background dual-transport swarm. Returns false if it is already
/// running or if the requested listener cannot be opened.
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
                .and_then(|runtime| {
                    runtime.block_on(async move {
                        run_swarm(rx, listen_tcp, listen_quic).await
                    });
                    Ok(())
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
    let keys = libp2p::identity::Keypair::generate_ed25519();
    let peer_id = PeerId::from(keys.public());
    let topic_blocks = gossipsub::IdentTopic::new(GOSSIP_BLOCKS);
    let topic_txs = gossipsub::IdentTopic::new(GOSSIP_TXS);
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

    while RUNNING.load(Ordering::Acquire) {
        while let Ok(command) = rx.try_recv() {
            match command {
                Command::Dial(addr) => {
                    if let Err(error) = swarm.dial(addr.clone()) {
                        eprintln!("[p2p-runtime] dial {addr} failed: {error}");
                    }
                }
            }
        }
        tokio::select! {
            event = swarm.select_next_some() => {
                if let SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } = event {
                    if let libp2p::core::ConnectedPoint::Dialer { address, .. } = endpoint {
                        swarm.behaviour_mut().kad.add_address(&peer_id, address);
                    }
                    let _ = swarm.behaviour_mut().kad.bootstrap();
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
    }
}

pub fn stop() {
    RUNNING.store(false, Ordering::Release);
    *command_slot().lock().expect("command mutex poisoned") = None;
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::Acquire)
}

pub fn connect(addr: &str) -> bool {
    let Ok(multiaddr) = Multiaddr::from_str(addr) else { return false; };
    let Some(sender) = command_slot().lock().expect("command mutex poisoned").as_ref().cloned() else {
        return false;
    };
    sender.send(Command::Dial(multiaddr)).is_ok()
}