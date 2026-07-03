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

#endif
