use libp2p::{
    core::{
        muxing::StreamMuxerBox,
        transport::OrTransport,
    },
    gossipsub, identity, noise, quic,
    swarm::{Config as SwarmConfig, Swarm},
    tcp, yamux,
    PeerId, Transport,
    core::upgrade::Version,
};
use futures::future::Either;
use std::error::Error;

pub async fn create_swarm() -> Result<Swarm<gossipsub::Behaviour>, Box<dyn Error>> {
    let id_keys = identity::Keypair::generate_ed25519();
    let peer_id = PeerId::from(id_keys.public());

    let tcp_transport = tcp::tokio::Transport::default()
        .upgrade(Version::V1)
        .authenticate(noise::Config::new(&id_keys)?)
        .multiplex(yamux::Config::default())
        ;
    let quic_transport = quic::tokio::Transport::new(quic::Config::new(&id_keys));
    let transport = OrTransport::new(quic_transport, tcp_transport)
        .map(|output, _| match output {
            Either::Left((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
            Either::Right((peer, muxer)) => (peer, StreamMuxerBox::new(muxer)),
        })
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
