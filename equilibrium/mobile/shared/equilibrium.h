#ifndef EQUILIBRIUM_H
#define EQUILIBRIUM_H

#include <stdint.h>

int solve_block(
    const uint8_t *prev_hash,
    const uint8_t *merkle_root,
    uint64_t timestamp,
    uint64_t difficulty,
    uint32_t recursion_depth,
    double mempool_pressure,
    uint64_t cum_work,
    uint64_t max_attempts,
    uint64_t *out_nonce,
    double *out_residual
);

/* Embedded mobile swarm. A zero QUIC port disables the UDP listener. */
int start_p2p_runtime(uint16_t listen_tcp, uint16_t listen_quic);
void stop_p2p_runtime(void);
int p2p_runtime_running(void);
int connect_p2p_peer(const uint8_t *addr, uintptr_t len);

#endif
