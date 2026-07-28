package com.equilibrium

import android.content.Context
import android.util.Log
import androidx.work.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * MiningWorker — WorkManager worker that runs one Proof-of-Stationarity
 * mining cycle per invocation.
 *
 * Role: **P2P-assisted miner + thin client** (not a full offline node).
 *
 * Flow per cycle:
 *   1. Prefer P2P tip cache (`P2PNode.fetchTip`); fall back to HTTP
 *      GET /api/chain/status when the cache is empty
 *   2. pollGossip() — abort if a peer already announced this height
 *   3. solveBlock() — Rust JNI via libequilibrium_core.so
 *   4. pollGossip() again — discard stale solution if a peer won mid-solve
 *   5. POST /api/blocks/submit — still required for body acceptance until
 *      phone implements sync RR; then setLocalTip + gossipBlock
 *
 * Input data keys (set by MiningService):
 *   [KEY_NODE_URL]       — base URL of the Equilibrium node  (default: emulator localhost)
 *   [KEY_MINER_ADDRESS]  — 40-char hex address that receives the coinbase reward
 *
 * WorkManager constraints (set by MiningService):
 *   - Requires charging
 *   - Requires battery not low
 *   - Requires unmetered network
 */
class MiningWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    // ── JNI ──────────────────────────────────────────────────────────────────

    companion object {
        const val KEY_NODE_URL      = "node_url"
        const val KEY_MINER_ADDRESS = "miner_address"

        /** Default node URL for Android emulator — 10.0.2.2 is the emulator's host loopback. */
        const val DEFAULT_NODE_URL = "http://10.0.2.2:8080"

        private const val TAG                = "MiningWorker"
        private const val MAX_SOLVER_ATTEMPTS = 500_000L
        // Fixed-point scale used by the Rust solver's `residual` output (10^18).
        private const val RESIDUAL_SCALE = 1_000_000_000_000_000_000.0
        private val JSON_MEDIA_TYPE           = "application/json; charset=utf-8".toMediaType()

        init {
            System.loadLibrary("equilibrium_core")
        }
    }

    /**
     * Runs the Rust StationarySolver for one block's worth of work.
     *
     * @param prevHash        32-byte little-endian previous block hash
     * @param merkleRoot      32-byte merkle root placeholder (server recomputes from mempool)
     * @param timestamp       Unix seconds
     * @param difficulty      Current chain difficulty
     * @param recursionDepth  Lagrangian recursion depth (typically 2)
     * @param mempoolPressure Mempool pressure scalar [0, 1]
     * @param cumWork         Cumulative chain work estimate
     * @param maxAttempts     Maximum solver iterations before giving up
     * @param outNonce        Out: LongArray[0] receives the winning nonce
     * @param outResidual     Out: LongArray[0] receives the achieved residual, fixed-point
     *                        (scaled by 10^18) — never a Double, so this ARM build agrees
     *                        bit-for-bit with the x86 cloud validator's consensus check.
     * @return true if a solution meeting the residual threshold was found
     */
    external fun solveBlock(
        prevHash:        ByteArray,
        merkleRoot:      ByteArray,
        timestamp:       Long,
        difficulty:      Long,
        recursionDepth:  Int,
        mempoolPressure: Double,
        cumWork:         Long,
        maxAttempts:     Long,
        outNonce:        LongArray,
        outResidual:     LongArray
    ): Boolean

    // ── OkHttp client (shared across invocations via companion if needed) ─────

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    // ── doWork ────────────────────────────────────────────────────────────────

    override fun doWork(): Result {
        val nodeUrl      = inputData.getString(KEY_NODE_URL)      ?: DEFAULT_NODE_URL
        val minerAddress = inputData.getString(KEY_MINER_ADDRESS) ?: run {
            Log.e(TAG, "No miner address configured — aborting mining cycle")
            return Result.failure(
                workDataOf("error" to "miner_address input data key is required")
            )
        }

        // ── 1. Fetch current chain tip ────────────────────────────────────────
        // Prefer the P2P tip cache so we don't depend on the cloud HTTP node
        // when peers are reachable.  Fall back to HTTP if P2P has no tip yet.
        val status: JSONObject = run {
            if (P2PNode.isRunning()) {
                val tipJson = P2PNode.fetchTip()
                if (tipJson.isNotEmpty()) {
                    val p2pTip = runCatching { JSONObject(tipJson) }.getOrNull()
                    if (p2pTip != null) {
                        Log.d(TAG, "Using P2P tip: ${p2pTip.optString("hash","?").take(16)}…")
                        return@run p2pTip
                    }
                }
            }
            fetchChainStatus(nodeUrl) ?: run {
                Log.w(TAG, "Could not reach node at $nodeUrl — will retry")
                return Result.retry()
            }
        }

        // Normalise key names: P2P tip uses "hash", HTTP status uses "latestHash".
        val latestHash      = status.optString("hash").ifEmpty { status.getString("latestHash") }
        val difficulty      = status.getLong("difficulty")
        val height          = status.getInt("height")
        val mempoolPressure = status.optDouble("mempoolPressure", 0.0)
        val cumulativeWork  = difficulty * height.toLong()

        Log.d(TAG, "Chain tip: height=$height hash=${latestHash.take(16)}…")

        // Seed / refresh local tip from whatever source we used (P2P or HTTP)
        // so the next cycle can prefer the P2P path even if this cycle used HTTP.
        if (P2PNode.isRunning() && latestHash.isNotEmpty()) {
            P2PNode.setLocalTip(height.toLong(), latestHash, difficulty)
        }

        // ── 1b. Abort early if a peer already won this height ─────────────────
        if (P2PNode.isRunning()) {
            val competing = P2PNode.pollGossip()
            if (competing.isNotEmpty()) {
                Log.i(TAG, "Peer already gossiped block at this height ($competing) — skip cycle")
                return Result.success()
            }
        }

        // ── 2. Run the Rust stationarity solver ───────────────────────────────
        val prevHashBytes   = hexToByteArray(latestHash)
        val merkleRootBytes = ByteArray(32) // placeholder — server recomputes from mempool
        val timestamp       = System.currentTimeMillis() / 1000L
        val outNonce        = LongArray(1)
        val outResidual     = LongArray(1) // fixed-point, scaled by 10^18

        val solved = solveBlock(
            prevHashBytes, merkleRootBytes,
            timestamp, difficulty,
            2, mempoolPressure, cumulativeWork,
            MAX_SOLVER_ATTEMPTS, outNonce, outResidual
        )

        if (!solved) {
            Log.d(TAG, "No solution found this cycle (exhausted $MAX_SOLVER_ATTEMPTS attempts)")
            return Result.success() // not a failure — just didn't win this round
        }

        val nonce      = outNonce[0]
        val residualFp = outResidual[0]
        // The node API still speaks floating-point residuals over JSON — convert once,
        // here, at the network boundary. The consensus-critical comparison already
        // happened inside the Rust solver using pure fixed-point i64 arithmetic.
        val residual   = residualFp.toDouble() / RESIDUAL_SCALE
        Log.i(TAG, "Solution found: nonce=$nonce residual=$residual (fixed-point=$residualFp)")

        // ── 2b. Re-check race after a long solve ──────────────────────────────
        if (P2PNode.isRunning()) {
            val competing = P2PNode.pollGossip()
            if (competing.isNotEmpty()) {
                Log.i(TAG, "Peer won while we solved ($competing) — discarding stale solution")
                return Result.success()
            }
        }

        // ── 3. Submit solved block to the node ────────────────────────────────
        return submitBlock(
            nodeUrl      = nodeUrl,
            miner        = minerAddress,
            prevHash     = latestHash,
            nonce        = nonce,
            residual     = residual,
            timestamp    = timestamp,
            difficulty   = difficulty,
        )
    }

    // ── Network helpers ───────────────────────────────────────────────────────

    /**
     * GET /api/chain/status
     * Returns the parsed JSON object, or null on any network / parse error.
     */
    private fun fetchChainStatus(nodeUrl: String): JSONObject? {
        val request = Request.Builder()
            .url("$nodeUrl/api/chain/status")
            .get()
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "chain/status returned HTTP ${response.code}")
                    return null
                }
                JSONObject(response.body!!.string())
            }
        } catch (e: IOException) {
            Log.w(TAG, "chain/status request failed: ${e.message}")
            null
        } catch (e: Exception) {
            Log.w(TAG, "chain/status parse error: ${e.message}")
            null
        }
    }

    /**
     * POST /api/blocks/submit
     *
     * Sends the solved nonce + residual to the node so it can add the block
     * to the canonical chain.
     *
     * HTTP 201 → success (block accepted)
     * HTTP 409 → stale work (chain tip advanced while solving) → success (don't retry stale)
     * HTTP 422 → residual above threshold → success (don't retry invalid work)
     * HTTP 4xx → permanent failure → success (don't retry)
     * HTTP 5xx / network error → retry
     */
    private fun submitBlock(
        nodeUrl:    String,
        miner:      String,
        prevHash:   String,
        nonce:      Long,
        residual:   Double,
        timestamp:  Long,
        difficulty: Long,
    ): Result {
        val payload = JSONObject().apply {
            put("miner",     miner)
            put("prevHash",  prevHash)
            put("nonce",     nonce)
            put("residual",  residual)
            put("timestamp", timestamp)
        }.toString()

        val request = Request.Builder()
            .url("$nodeUrl/api/blocks/submit")
            .post(payload.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            http.newCall(request).execute().use { response ->
                val body = response.body?.string() ?: ""
                when {
                    response.isSuccessful -> {
                        val json = runCatching { JSONObject(body) }.getOrNull()
                        val acceptedHeight = json?.optInt("height", -1) ?: -1
                        val blockHash      = json?.optString("hash") ?: ""
                        Log.i(TAG, "Block accepted at height $acceptedHeight")

                        // Update the local P2P tip cache so subsequent cycles
                        // can use P2P tip without hitting the HTTP node.
                        if (blockHash.isNotEmpty() && acceptedHeight >= 0) {
                            P2PNode.setLocalTip(acceptedHeight.toLong(), blockHash, difficulty)
                        }

                        // Propagate the solved block to connected peers so they
                        // can skip re-solving this height.  No-op when the P2P
                        // swarm is not running or no peers are connected.
                        if (blockHash.isNotEmpty() && P2PNode.isRunning()) {
                            val gossiped = P2PNode.gossipBlock(blockHash)
                            Log.d(TAG, "gossipBlock($blockHash): $gossiped")
                        }

                        Result.success(
                            workDataOf(
                                "accepted_height" to acceptedHeight,
                                "block_hash"      to blockHash,
                                "reward"          to (json?.optLong("reward") ?: 0L),
                            )
                        )
                    }
                    response.code == 409 -> {
                        // Stale — chain tip advanced while we were solving; not a worker failure
                        Log.d(TAG, "Stale block rejected (409) — chain tip advanced")
                        Result.success()
                    }
                    response.code == 422 -> {
                        // Residual didn't meet threshold — not a worker failure
                        Log.w(TAG, "Block rejected: residual above threshold (422)")
                        Result.success()
                    }
                    response.code in 400..499 -> {
                        Log.e(TAG, "Block rejected with HTTP ${response.code}: $body")
                        Result.failure(workDataOf("error" to "HTTP ${response.code}: $body"))
                    }
                    else -> {
                        Log.w(TAG, "Node returned HTTP ${response.code} — will retry")
                        Result.retry()
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "submitBlock network error — will retry: ${e.message}")
            Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "submitBlock unexpected error: ${e.message}")
            Result.failure(workDataOf("error" to (e.message ?: "unknown")))
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    /**
     * Convert a hex string (with or without 0x prefix) to a 32-byte array.
     * Short strings are left-padded with zeros; long strings are right-truncated
     * to the first 64 hex characters (32 bytes).
     */
    private fun hexToByteArray(hex: String): ByteArray {
        val clean  = if (hex.startsWith("0x", ignoreCase = true)) hex.substring(2) else hex
        val padded = clean.padStart(64, '0').takeLast(64)
        return ByteArray(32) { i ->
            padded.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }
}
