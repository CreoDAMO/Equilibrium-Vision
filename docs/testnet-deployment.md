# Equilibrium Testnet Deployment

Multi-region deployment guide for a geographically distributed Equilibrium testnet.

## Architecture

```
              ┌─────────────────────────────────────────────┐
              │              Public Internet                  │
              └───────────┬──────────────┬───────────────────┘
                          │              │
              ┌───────────▼──┐    ┌──────▼────────┐
              │  Seed Node 1 │    │  Seed Node 2  │   (more regions)
              │  Falkenstein │    │   Helsinki    │
              │  CX23 2vCPU  │    │  CX23 2vCPU  │
              │  4GB RAM     │    │  4GB RAM      │
              └──────┬───────┘    └──────┬─────────┘
                     │  libp2p gossip    │
              ┌──────▼───────────────────▼─────────┐
              │          API + Explorer             │
              │    (any region, behind Caddy TLS)   │
              └─────────────────────────────────────┘
```

## Recommended Hetzner Instance Sizes (July 2026)

| Role | Instance | vCPU | RAM | Note |
|---|---|---|---|---|
| Seed / validator node | CX23 | 2 | 4 GB | €4–5/mo EU; stable price |
| API server + explorer | CX23 or CAX21 | 2 | 4 GB | CAX21 is ARM, slightly cheaper |
| Archive / Postgres node | AX line (dedicated) | 4+ | 16 GB+ | For full block history |
| CI build runner | CPX21 on-demand | 3 | 4 GB | Bill hourly, delete after build |

> **Note:** CPX/CCX prices increased ~2–3x in June 2026. Prefer CX/CAX for testnet nodes.

## Quickstart: Single Combined Box

```bash
# 1. Provision a CX23 and SSH in

# 2. Install Docker
curl -fsSL https://get.docker.com | sh

# 3. Clone the repo
git clone https://github.com/your-org/equilibrium.git
cd equilibrium

# 4. Build the Docker image (uses the repo's Dockerfile)
docker build -t equilibrium:latest .

# 5. Create .env
cat > .env <<EOF
PORT=8080
NODE_ENV=production
DATABASE_URL=postgresql://equ:secret@localhost:5432/equilibrium
EOF

# 6. Run with Docker Compose
docker compose up -d
```

## Multi-Node Setup

### Step 1: Provision seed nodes (one per region)

```bash
# Repeat in Falkenstein, Helsinki, Ashburn (or choose 2 for testnet)
hcloud server create \
  --name equ-seed-fkb \
  --type cx23 \
  --image debian-12 \
  --location fsn1 \
  --ssh-key your-key
```

### Step 2: Configure libp2p bootstrap peers

In each node's config, add the other seed node multiaddrs:

```env
# .env on each seed node
P2P_BOOTSTRAP_PEERS=/ip4/1.2.3.4/tcp/9000/p2p/QmSeedNode1PeerId,/ip4/5.6.7.8/tcp/9000/p2p/QmSeedNode2PeerId
```

### Step 3: Configure Caddy for TLS termination

```caddyfile
# /etc/caddy/Caddyfile
node.example.com {
    reverse_proxy /api* localhost:8080
    reverse_proxy /ws    localhost:8080
    reverse_proxy /*     localhost:5000
}
```

### Step 4: Configure Hetzner Firewall

```bash
hcloud firewall create --name equ-firewall
# Allow HTTP/HTTPS from anywhere
hcloud firewall add-rule equ-firewall --direction in --port 80 --protocol tcp --source-ips 0.0.0.0/0,::/0
hcloud firewall add-rule equ-firewall --direction in --port 443 --protocol tcp --source-ips 0.0.0.0/0,::/0
# Allow libp2p P2P port between seed nodes only (add seed node IPs)
hcloud firewall add-rule equ-firewall --direction in --port 9000 --protocol tcp --source-ips <seed1-ip>/32 <seed2-ip>/32
# Allow Stratum mining pool (if enabled)
hcloud firewall add-rule equ-firewall --direction in --port 3333 --protocol tcp --source-ips 0.0.0.0/0,::/0
```

## Postgres Setup (for persistence)

```bash
# On the same box or a dedicated CX23
docker run -d \
  --name equ-postgres \
  -e POSTGRES_USER=equ \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=equilibrium \
  -p 5432:5432 \
  -v equ-pgdata:/var/lib/postgresql/data \
  postgres:17

# Run Drizzle migrations
cd lib/db && DATABASE_URL=postgresql://equ:secret@localhost:5432/equilibrium pnpm run push
```

## Monitoring

- **Prometheus** metrics at `https://node.example.com/metrics`
- Scrape interval: 15s (matches block time)
- Key metrics: `equ_height`, `equ_mempool_size`, `equ_peer_count`

## Health check

```bash
curl https://node.example.com/api/healthz
# → {"status":"ok"}
```

## Pinned Rust MSRV

The Rust crate requires **Rust 1.81+** (Cargo.lock v4 format, `edition2024`).
Pin the toolchain in CI with `rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.81"
```
