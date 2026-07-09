package com.equilibrium.ai

import android.util.Log
import org.json.JSONObject

/**
 * JNI bridge to the variational-ai Rust library (`libvariational_ai.so`).
 *
 * This is a separate native library from the consensus core (`libequilibrium_core.so`
 * loaded by MiningWorker). It exposes the NTK / logistic solver directly to
 * Kotlin so the on-device training loop can be called independently, e.g. to
 * warm up the NPU, benchmark accuracy, or solve a block using the AI-guided path.
 *
 * All external functions are declared here and implemented in:
 *   variational-ai/src/jni_bridge.rs
 *   (compiled with `--features jni-bridge` via cargo-ndk)
 */
object VariationalAI {
    private const val TAG = "VariationalAI"

    init {
        System.loadLibrary("variational_ai")
    }

    // ── Raw JNI declarations ──────────────────────────────────────────────────

    /**
     * Train a logistic regression model on synthetic MNIST (binary 0 vs 1).
     * @return DoubleArray [testAccuracy, gradientNormResidual]
     */
    external fun trainLogistic(): DoubleArray

    /**
     * Train an NTK (Neural Tangent Kernel) model on synthetic MNIST.
     * @return DoubleArray [testAccuracy, gradientNormResidual]
     */
    external fun trainNtk(): DoubleArray

    /**
     * Solve a block using the variational NTK solver, seeded by the block header.
     *
     * @param blockData JSON-encoded block header:
     *   `{ "prevHash": "<64 hex chars>", "difficulty": <long>, "timestamp": <long> }`
     * @return JSON-encoded solution bytes:
     *   `{ "nonce": <long>, "residual": <double>, "accuracy": <double> }`
     *   Returns `{}` on any internal Rust panic (solver failure is non-fatal).
     */
    external fun solveBlock(blockData: ByteArray): ByteArray

    // ── Kotlin-friendly wrappers ──────────────────────────────────────────────

    /**
     * Result type returned by the high-level solve / train wrappers.
     */
    data class SolverResult(
        val accuracy: Double,
        val residual: Double,
        val nonce: Long? = null,
    )

    /**
     * Train the logistic regression model and return structured results.
     * Returns null if the native call panics.
     */
    fun runLogisticTraining(): SolverResult? = runCatching {
        val arr = trainLogistic()
        if (arr.size < 2 || arr[0] < 0.0) {
            Log.e(TAG, "trainLogistic returned error sentinel")
            return@runCatching null
        }
        Log.i(TAG, "Logistic: accuracy=${arr[0].format()} residual=${arr[1].format()}")
        SolverResult(accuracy = arr[0], residual = arr[1])
    }.onFailure { Log.e(TAG, "trainLogistic native error", it) }.getOrNull()

    /**
     * Train the NTK model and return structured results.
     * Returns null if the native call panics.
     */
    fun runNtkTraining(): SolverResult? = runCatching {
        val arr = trainNtk()
        if (arr.size < 2 || arr[0] < 0.0) {
            Log.e(TAG, "trainNtk returned error sentinel")
            return@runCatching null
        }
        Log.i(TAG, "NTK: accuracy=${arr[0].format()} residual=${arr[1].format()}")
        SolverResult(accuracy = arr[0], residual = arr[1])
    }.onFailure { Log.e(TAG, "trainNtk native error", it) }.getOrNull()

    /**
     * Solve a block using the variational NTK path.
     *
     * @param prevHash    Previous block hash (hex string, 64 chars)
     * @param difficulty  Current chain difficulty
     * @param timestamp   Unix seconds
     * @return SolverResult with nonce on success, null on Rust panic.
     */
    fun solveBlockHeader(prevHash: String, difficulty: Long, timestamp: Long): SolverResult? {
        return runCatching {
            val json = """{"prevHash":"$prevHash","difficulty":$difficulty,"timestamp":$timestamp}"""
            val resultBytes = solveBlock(json.toByteArray(Charsets.UTF_8))
            val result = JSONObject(String(resultBytes, Charsets.UTF_8))

            if (!result.has("nonce")) {
                Log.e(TAG, "solveBlock returned empty result")
                return@runCatching null
            }

            val nonce    = result.getLong("nonce")
            val residual = result.getDouble("residual")
            val accuracy = result.getDouble("accuracy")
            Log.i(TAG, "Block solved: nonce=$nonce residual=${residual.format()} accuracy=${accuracy.format()}")
            SolverResult(accuracy = accuracy, residual = residual, nonce = nonce)
        }.onFailure { Log.e(TAG, "solveBlock native error", it) }.getOrNull()
    }

    private fun Double.format() = "%.6f".format(this)
}
