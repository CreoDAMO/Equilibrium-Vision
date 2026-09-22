-- Unowned public chain state. No user_id. No bulk wipe.
create table if not exists eq_chain_meta (
  network text primary key,
  difficulty double precision not null,
  couplings jsonb not null,
  height integer not null,
  last_mine_at bigint not null default 0,
  body jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists eq_blocks (
  network text not null,
  height integer not null,
  hash text not null,
  residual double precision not null,
  pressure double precision not null,
  finalized boolean not null default false,
  body jsonb not null,
  primary key (network, height)
);
create unique index if not exists eq_blocks_hash_idx on eq_blocks (network, hash);

create table if not exists eq_accounts (
  network text not null,
  address text not null,
  balance double precision not null,
  nonce integer not null,
  primary key (network, address)
);

create table if not exists eq_experiments (
  id serial primary key,
  network text not null,
  kind text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists eq_experiments_net_idx on eq_experiments (network, id desc);
