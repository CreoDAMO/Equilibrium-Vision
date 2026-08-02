export function buildGenesisChain(): ChainState {
  const state = new ChainState();

  const miner1 = makeAddress("equilibrium-miner-1");
  const miner2 = makeAddress("equilibrium-miner-2");
  const alice = makeAddress("equilibrium-alice");
  const bob = makeAddress("equilibrium-bob");
  const carol = makeAddress("equilibrium-carol");

  seedValidators(state);
  seedDexPools(state);

  // Fixed peer IDs — no randomHex
  state.peers = [
    { peerId: "a".repeat(40), address: "192.168.1.10:30303", latencyMs: 12, height: 0, connected: true, syncState: "synced" },
    { peerId: "b".repeat(40), address: "10.0.0.55:30303", latencyMs: 34, height: 0, connected: true, syncState: "synced" },
    { peerId: "c".repeat(40), address: "172.16.0.3:30303", latencyMs: 89, height: 0, connected: false, syncState: "behind" },
    { peerId: "d".repeat(40), address: "203.0.113.7:30303", latencyMs: 142, height: 0, connected: true, syncState: "syncing" },
  ];

  const miners = [miner1, miner2];
  // Fixed origin time so repeated genesis builds are stable in tests
  let now = 1_700_000_000;
  let prevHash = "0".repeat(64);

  for (let h = 0; h <= 24; h++) {
    const miner = miners[h % 2]!;
    // Deterministic residual (no Math.random)
    const residual = 1e-9 * (1 + (h % 97) / 100);
    const quality = 1.0 / (residual + 1e-6);
    const reward = Math.floor(BASE_REWARD * Math.min(quality, 1.0));
    state.ledger.credit(miner, reward);

    const txs: TxRecord[] = [];
    const blockHash = hash256(`block-${h}-${prevHash}`);

    if (h >= 3) {
      const txHash = hash256(`tx-${h}-alice`);
      const tx: TxRecord = {
        hash: txHash,
        from: miner,
        to: alice,
        amount: 1_000_000,
        fee: 1_000,
        nonce: Math.floor(h / 2),
        blockHash,
        blockHeight: h,
        timestamp: now,
        status: "confirmed",
      };
      txs.push(tx);
      state.txIndex.set(txHash, tx);
      if (!state.addressTxs.has(miner)) state.addressTxs.set(miner, new Set());
      if (!state.addressTxs.has(alice)) state.addressTxs.set(alice, new Set());
      state.addressTxs.get(miner)!.add(txHash);
      state.addressTxs.get(alice)!.add(txHash);
      state.ledger.credit(alice, 1_000_000);
    }
    if (h >= 8) {
      const txHash = hash256(`tx-${h}-bob`);
      const tx: TxRecord = {
        hash: txHash,
        from: alice,
        to: bob,
        amount: 250_000,
        fee: 500,
        nonce: Math.floor((h - 8) / 3),
        blockHash,
        blockHeight: h,
        timestamp: now,
        status: "confirmed",
      };
      txs.push(tx);
      state.txIndex.set(txHash, tx);
      if (!state.addressTxs.has(bob)) state.addressTxs.set(bob, new Set());
      state.addressTxs.get(alice)!.add(txHash);
      state.addressTxs.get(bob)!.add(txHash);
      state.ledger.credit(bob, 250_000);
    }
    if (h >= 15) {
      const txHash = hash256(`tx-${h}-carol`);
      const tx: TxRecord = {
        hash: txHash,
        from: bob,
        to: carol,
        amount: 50_000,
        fee: 200,
        nonce: h - 15,
        blockHash,
        blockHeight: h,
        timestamp: now,
        status: "confirmed",
      };
      txs.push(tx);
      state.txIndex.set(txHash, tx);
      if (!state.addressTxs.has(carol)) state.addressTxs.set(carol, new Set());
      state.addressTxs.get(bob)!.add(txHash);
      state.addressTxs.get(carol)!.add(txHash);
      state.ledger.credit(carol, 50_000);
    }

    const txHashes = txs.map((t) => t.hash);
    const mr = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);

    const block: BlockRecord = {
      hash: blockHash,
      height: h,
      prevHash,
      merkleRoot: mr,
      timestamp: now,
      nonce: h * 1_000_003 + 42,
      difficulty: state.currentDifficulty,
      residual,
      residualFp: Math.floor(residual * 1e18),
      recursionDepth: 2,
      coinbaseReward: reward,
      miner,
      txCount: txs.length,
      transactions: txs,
      finalized: false,
    };

    state.blocks.push(block);

    const prevBlock = state.blocks[h - 1];
    const blockTime = prevBlock ? block.timestamp - prevBlock.timestamp : TARGET_BLOCK_TIME;
    state.blockStats.push({
      height: h,
      txCount: txs.length,
      residual,
      // Deterministic fixture pressure (no Math.random)
      mempoolPressure: 0.25 + ((h % 10) / 20),
      timestamp: now,
      difficulty: state.currentDifficulty,
      blockTime,
    });

    state.updateDifficulty();
    state.runFinalityRound(block);
    for (const p of state.peers) p.height = h;

    const vMiner = state.validators.get(miner);
    if (vMiner) {
      vMiner.blocksProposed += 1;
      vMiner.accumulatedRewards += reward;
    }

    prevHash = blockHash;
    // Deterministic inter-block spacing (no Math.random)
    now += 12 + (h % 6);
  }

  // Deterministic mempool seed (no Date.now)
  for (let i = 0; i < 6; i++) {
    const txHash = hash256(`mempool-${i}`);
    const tx: TxRecord = {
      hash: txHash,
      from: alice,
      to: carol,
      amount: 10_000 * (i + 1),
      fee: 100 + i * 50,
      nonce: 100 + i,
      blockHash: null,
      blockHeight: null,
      timestamp: now + i,
      status: "pending",
    };
    state.mempool.add(tx);
  }

  return state;
}
