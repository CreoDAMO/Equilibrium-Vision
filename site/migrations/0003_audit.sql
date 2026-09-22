-- Bidirectional comparisons and mesh sightings. Unowned. No bulk delete.
create table if not exists eq_bidirectional (
  network text not null,
  height integer not null,
  claimed_r double precision not null,
  inferred_r double precision not null,
  agree boolean not null,
  discovery_iters integer not null,
  verify_evals integer not null,
  created_at timestamptz not null default now(),
  primary key (network, height)
);

create table if not exists eq_mesh_obs (
  id serial primary key,
  network text not null,
  peer_id text not null,
  height integer not null,
  hash text not null,
  agree boolean not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists eq_mesh_obs_net_idx on eq_mesh_obs (network, id desc);
