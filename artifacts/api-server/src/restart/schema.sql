CREATE TABLE IF NOT EXISTS blocks (
  hash text PRIMARY KEY,
  height integer NOT NULL,
  prev_hash text NOT NULL,
  merkle_root text NOT NULL,
  timestamp bigint NOT NULL,
  nonce bigint NOT NULL,
  difficulty real NOT NULL,
  residual real NOT NULL,
  residual_fp bigint,
  miner text NOT NULL,
  tx_count integer NOT NULL DEFAULT 0,
  coinbase_reward bigint NOT NULL DEFAULT 0,
  finalized boolean NOT NULL DEFAULT false,
  zk_proof jsonb,
  state_root text
);
CREATE INDEX IF NOT EXISTS blocks_height_idx ON blocks (height);
CREATE INDEX IF NOT EXISTS blocks_miner_idx ON blocks (miner);

CREATE TABLE IF NOT EXISTS transactions (
  hash text PRIMARY KEY,
  block_hash text,
  block_height integer,
  from_address text NOT NULL,
  to_address text NOT NULL,
  amount bigint NOT NULL,
  fee bigint NOT NULL DEFAULT 0,
  nonce bigint NOT NULL,
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  timestamp bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS state_snapshots (
  height integer PRIMARY KEY,
  block_hash text NOT NULL,
  state_root text NOT NULL,
  ledger jsonb NOT NULL,
  utxos jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS state_snapshots_height_idx ON state_snapshots (height);
