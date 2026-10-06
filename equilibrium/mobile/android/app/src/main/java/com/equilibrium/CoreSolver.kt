package com.equilibrium

/**
 * Same JNI solve the worker uses, so the foreground service can search
 * without constructing a WorkManager [MiningWorker].
 *
 * This does not receive Ω.λ, does not apply the successor, and does not
 * install Ω. A true result is a nonce the Rust search admitted under its
 * own inputs, not a committed block.
 */
object CoreSolver {
    init {
        System.loadLibrary("equilibrium_core")
    }

    external fun solveBlock(
        prevHash: ByteArray,
        merkleRoot: ByteArray,
        timestamp: Long,
        difficulty: Long,
        recursionDepth: Int,
        mempoolPressure: Double,
        cumWork: Long,
        maxAttempts: Long,
        outNonce: Array<String>,
        outResidual: LongArray,
    ): Boolean
}
