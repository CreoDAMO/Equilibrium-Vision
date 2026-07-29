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

        private const val VALIDATION_POLL_MS    = 50L
        private const val VALIDATION_TIMEOUT_MS = 8_000L

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

        // ── 0. Ensure background validator is running ─────────────────────────
        ensureValidator()

        // ── 0b. Adopt a peer block (with validation) if one arrived ───────────
        if (tryAdoptPeerBlock()) return Result.success()

        // ── 1. Fetch current chain tip ─────────────────────────────────────────
        // Priority: (1) local P2P cache, (2) P2P lightnode RR from a peer,
        // (3) HTTP /api/chain/status.  Only tier 3 requires the cloud node.
        val status: JSONObject = run {
            // 1a. Local tip cache — instant, zero network
            if (P2PNode.isRunning()) {
                val tipJson = P2PNode.fetchTip()
                if (tipJson.isNotEmpty()) {
                    val p2pTip = runCatching { JSONObject(tipJson) }.getOrNull()
                    if (p2pTip != null) {
                        Log.d(TAG, "Tip from local cache: ${p2pTip.optString("hash","?").take(16)}…")
                        return@run p2pTip
                    }
                }
            }
            // 1b. P2P lightnode RR — ask a connected peer (~1–5 s, no HTTP)
            if (P2PNode.isRunning()) {
                val rrJson = P2PNode.queryLightnodeTip()
                if (rrJson.isNotEmpty()) {
                    val rrTip = runCatching { JSONObject(rrJson) }.getOrNull()
                    if (rrTip != null) {
                        Log.d(TAG, "Tip from P2P lightnode: ${rrTip.optString("hash","?").take(16)}…")
                        return@run rrTip
                    }
                }
            }
            // 1c. HTTP fallback — last resort when no peers are reachable
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
        // (validated before tip advance — tryAdoptPeerBlock handles this)
        if (tryAdoptPeerBlock()) {
            Log.i(TAG, "Peer block adopted mid-tip-fetch — skip solve this cycle")
            return Result.success()
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
        if (tryAdoptPeerBlock()) {
            Log.i(TAG, "Peer won while we solved — discarding stale solution")
            return Result.success()
        }

        // ── 3. P2P-first block propagation ───────────────────────────────────
        // If we have peers, gossip the block then validate before advancing tip.
        // Tip advance ONLY on Accept — never on Reject or Deferred.
        val blockHash = computeBlockHash(latestHash, nonce, timestamp, difficulty)
        val blockBodyJson = buildBlockBodyJson(
            hash       = blockHash,
            height     = height + 1,
            prevHash   = latestHash,
            nonce      = nonce,
            residual   = residual,
            timestamp  = timestamp,
            miner      = minerAddress,
            difficulty = difficulty,
        )

        if (P2PNode.isRunning() && P2PNode.getConnectedPeerCount() > 0) {
            val bodySent = P2PNode.gossipBlockBody(blockBodyJson)
            val hashSent = P2PNode.gossipBlock(blockHash)
            if (bodySent && hashSent) {
                Log.i(TAG, "Block gossiped — validating before tip advance")
                if (validateAndAwaitAccept(blockBodyJson, fromPeer = false)) {
                    P2PNode.setLocalTip((height + 1).toLong(), blockHash, difficulty)
                    P2PNode.pushBlockBody(blockBodyJson)
                    Log.i(TAG, "Local tip advanced after Accept")
                    return Result.success()
                }
                Log.w(TAG, "Self-mined body failed local validation — no tip advance, falling back to HTTP")
            }
            Log.w(TAG, "P2P gossip failed — falling back to HTTP submit")
        }

        // ── 4. HTTP fallback: submit solved block to the node ─────────────────
        return submitBlock(
            nodeUrl      = nodeUrl,
            miner        = minerAddress,
            prevHash     = latestHash,
            nonce        = nonce,
            residual     = residual,
            timestamp    = timestamp,
            difficulty   = difficulty,
            blockBodyJson = blockBodyJson,
        )
    }

    // ── Validation helpers ────────────────────────────────────────────────────

    /** Start the Rust background validator if P2P is running (idempotent). */
    private fun ensureValidator() {
        if (P2PNode.isRunning()) {
            P2PNode.startValidator()
        }
    }

    /**
     * Submit [blockBodyJson] to the background Rust validator and poll until it
     * returns Accept, Reject, or Deferred.
     *
     * @param fromPeer true for blocks received from peers (triggers peer-ban on reject).
     * @return true ONLY on "status":"accept"; false on reject, deferred, or timeout.
     */
    private fun validateAndAwaitAccept(blockBodyJson: String, fromPeer: Boolean): Boolean {
        ensureValidator()
        if (!P2PNode.shouldValidateNow()) {
            Log.i(TAG, "Validation deferred (battery/thermal)")
            return false
        }
        if (!P2PNode.submitBlockForValidation(blockBodyJson, fromPeer)) {
            Log.w(TAG, "submitBlockForValidation failed (validator not started?)")
            return false
        }
        val deadline = System.currentTimeMillis() + VALIDATION_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val raw = P2PNode.getValidationResult()
            if (raw.isNotEmpty()) {
                val json = runCatching { org.json.JSONObject(raw) }.getOrNull() ?: return false
                return when (json.optString("status")) {
                    "accept" -> {
                        Log.i(TAG, "Block validated: ${json.optString("hash").take(16)}…")
                        true
                    }
                    "reject" -> {
                        Log.w(TAG, "Block rejected: ${json.optString("reason")}")
                        false
                    }
                    "deferred" -> {
                        Log.i(TAG, "Validation deferred: ${json.optString("reason")}")
                        false
                    }
                    else -> false
                }
            }
            try { Thread.sleep(VALIDATION_POLL_MS) } catch (_: InterruptedException) { return false }
        }
        Log.w(TAG, "Validation timed out after ${VALIDATION_TIMEOUT_MS}ms")
        return false
    }

    /**
     * Check for a gossiped peer block, fetch its body, validate it, and adopt it
     * (advance tip + ring) ONLY on Accept.
     *
     * @return true if we handled a peer block this cycle (mining should be skipped),
     *         false if no peer block was available.
     */
    private fun tryAdoptPeerBlock(): Boolean {
        if (!P2PNode.isRunning()) return false
        val competingHash = P2PNode.pollGossip()
        if (competingHash.isEmpty()) return false

        Log.i(TAG, "Peer gossip hash=${competingHash.take(16)}… — fetching body")
        val body = P2PNode.querySyncBlock(competingHash)
        if (body.isEmpty()) {
            Log.w(TAG, "No body for peer hash — cannot validate; skipping mine cycle")
            return true // skip mine; don't tip without validation
        }

        if (!validateAndAwaitAccept(body, fromPeer = true)) {
            Log.w(TAG, "Peer block failed validation — tip unchanged")
            return true // still skip mine for this cycle
        }

        val obj = runCatching { org.json.JSONObject(body) }.getOrNull()
        val h    = obj?.optLong("height", -1L) ?: -1L
        val hash = obj?.optString("hash")?.ifEmpty { competingHash } ?: competingHash
        val diff = obj?.optLong("difficulty", 0L) ?: 0L
        if (h >= 0 && hash.isNotEmpty()) {
            P2PNode.setLocalTip(h, hash, diff)
            P2PNode.pushBlockBody(body)
            Log.i(TAG, "Tip advanced after peer Accept: height=$h")
        }
        return true
    }

    /**
     * Compute the block hash locally so we can gossip it before HTTP confirmation.
     * Matches the server's hash: sha256(prevHash || nonce || timestamp || difficulty).
     */
    private fun computeBlockHash(prevHash: String, nonce: Long, timestamp: Long, difficulty: Long): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        md.update(hexToByteArray(prevHash))
        md.update(java.nio.ByteBuffer.allocate(8).putLong(nonce).array())
        md.update(java.nio.ByteBuffer.allocate(8).putLong(timestamp).array())
        md.update(java.nio.ByteBuffer.allocate(8).putLong(difficulty).array())
        return md.digest().joinToString("") { "%02x".format(it) }
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
        nodeUrl:      String,
        miner:        String,
        prevHash:     String,
        nonce:        Long,
        residual:     Double,
        timestamp:    Long,
        difficulty:   Long,
        blockBodyJson: String = "",
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

                        // Propagate the solved block hash + body to peers.
                        if (blockHash.isNotEmpty() && P2PNode.isRunning()) {
                            P2PNode.gossipBlock(blockHash)
                        }
                        if (P2PNode.isRunning() && blockBodyJson.isNotEmpty()) {
                            // Re-gossip body in case peers joined after the initial P2P attempt
                            P2PNode.gossipBlockBody(blockBodyJson)
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
     * Build the compact block body JSON used for P2P body gossip (Phase C).
     * Contains all fields peers need to validate the residual threshold and
     * serve the block via the sync RR protocol to other phones.
     *
     * Does NOT include the Merkle root or transaction list — phones only need
     * the mining-relevant fields, and the desktop node can recompute the rest.
     */
    private fun buildBlockBodyJson(
        hash:       String,
        height:     Int,
        prevHash:   String,
        nonce:      Long,
        residual:   Double,
        timestamp:  Long,
        miner:      String,
        difficulty: Long,
    ): String = JSONObject().apply {
        put("hash",       hash)
        put("height",     height)
        put("prevHash",   prevHash)
        put("nonce",      nonce)
        put("residual",   residual)
        put("timestamp",  timestamp)
        put("miner",      miner)
        put("difficulty", difficulty)
    }.toString()

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
