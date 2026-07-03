use libp2p::{
    gossipsub, identity, noise, swarm::Swarm, tcp, yamux, PeerId,
};
use std::error::Error;

pub async fn create_swarm() -> Result<Swarm<gossipsub::Behaviour>, Box<dyn Error>> {
    let id_keys = identity::Keypair::generate_ed25519();
    let peer_id = PeerId::from(id_keys.public());
    let transport = tcp::tokio::Transport::default()
        .upgrade(noise::Config::new(&id_keys)?)
        .multiplex(yamux::Config::default())
        .boxed();
    let behaviour = gossipsub::Behaviour::new(gossipsub::MessageAuthenticity::Signed(id_keys))?;
    let swarm = Swarm::new(transport, behaviour, peer_id);
    Ok(swarm)
}
