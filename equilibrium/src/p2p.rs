use libp2p::{
    gossipsub, identity, noise,
    swarm::{Swarm, SwarmConfig},
    tcp, yamux,
    PeerId, Transport,
    core::upgrade::Version,
};
use std::error::Error;

pub async fn create_swarm() -> Result<Swarm<gossipsub::Behaviour>, Box<dyn Error>> {
    let id_keys = identity::Keypair::generate_ed25519();
    let peer_id = PeerId::from(id_keys.public());

    let transport = tcp::tokio::Transport::default()
        .upgrade(Version::V1)
        .authenticate(noise::Config::new(&id_keys)?)
        .multiplex(yamux::Config::default())
        .boxed();

    let behaviour = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(id_keys),
        gossipsub::Config::default(),
    )?;

    let swarm = Swarm::new(
        transport,
        behaviour,
        peer_id,
        SwarmConfig::with_tokio_executor(),
    );
    Ok(swarm)
}
