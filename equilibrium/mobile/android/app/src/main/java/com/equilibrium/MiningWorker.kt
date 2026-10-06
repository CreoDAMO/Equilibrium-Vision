package com.equilibrium

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * One mining cycle, if something still enqueues this worker.
 *
 * The phone does not mine because this class exists. [MiningService] is
 * the loop that calls [MiningCycle]. An empty miner address is a failure,
 * not a default reward destination.
 */
class MiningWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    companion object {
        const val KEY_NODE_URL = "node_url"
        const val KEY_MINER_ADDRESS = "miner_address"

        /** Public site. Not the emulator host. */
        const val DEFAULT_NODE_URL = "https://equilibriums.site"

        private val MINER_ADDRESS = Regex("^[0-9a-f]{40}$")

        init {
            System.loadLibrary("equilibrium_core")
        }

        /** 40 hex characters, optional 0x. Null if the user did not supply one. */
        fun normalizeMinerAddress(raw: String?): String? {
            val text = raw?.trim()?.removePrefix("0x")?.removePrefix("0X")?.lowercase().orEmpty()
            return text.takeIf { MINER_ADDRESS.matches(it) }
        }
    }

    /**
     * JNI entry kept under this class name. [CoreSolver] calls the same Rust body.
     * Out-nonce is decimal text. A signed long is not a u64.
     */
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

    override fun doWork() = MiningCycle(applicationContext) { prev, merkle, timestamp, difficulty, depth, pressure, work, attempts, nonce, residual ->
        solveBlock(prev, merkle, timestamp, difficulty, depth, pressure, work, attempts, nonce, residual)
    }.run(
        inputData.getString(KEY_NODE_URL) ?: DEFAULT_NODE_URL,
        inputData.getString(KEY_MINER_ADDRESS),
    )
}
