package com.equilibrium

import android.content.Context
import android.util.Log
import androidx.work.workDataOf
import androidx.work.ListenableWorker.Result
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * One Proof-of-Stationarity search, then gossip or HTTP submit.
 *
 * The foreground service calls this in a loop. WorkManager, if it still
 * runs a worker, calls the same function. Neither path invents a miner
 * address, and neither path invents a difficulty when the host only
 * served the light report.
 */
class MiningCycle(
    @Suppress("unused") private val context: Context,
    private val solveBlock: CoreSolverSolve,
) {
    fun interface CoreSolverSolve {
        fun solveBlock(
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

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    fun run(nodeUrl: String, minerRaw: String?): Result {
        val minerAddress = MiningWorker.normalizeMinerAddress(minerRaw) ?: run {
            Log.e(TAG, "No miner address configured — aborting mining cycle")
            MiningState.solver = "miner address required"
            MiningState.lastSubmission = "not submitted"
            MiningState.note = "A 40-character hex reward address is required. None was assigned."
            return Result.failure(workDataOf("error" to "miner_address is required"))
        }

        if (P2PNode.isRunning()) P2PNode.startValidator()

        if (tryAdoptPeerBlock()) return Result.success()

        val status: JSONObject = run {
            if (P2PNode.isRunning()) {
                val tipJson = P2PNode.fetchTip()
                if (tipJson.isNotEmpty()) {
                    val p2pTip = runCatching { JSONObject(tipJson) }.getOrNull()
                    if (p2pTip != null) {
                        MiningState.httpTipSource = "P2P cache"
                        return@run p2pTip
                    }
                }
            }
            if (P2PNode.isRunning()) {
                val rrJson = P2PNode.queryLightnodeTip()
                if (rrJson.isNotEmpty()) {
                    val rrTip = runCatching { JSONObject(rrJson) }.getOrNull()
                    if (rrTip != null) {
                        MiningState.httpTipSource = "P2P"
                        return@run rrTip
                    }
                }
            }
            fetchChainStatus(nodeUrl) ?: run {
                noteLightOnly(nodeUrl)
                return Result.retry()
            }
        }

        val latestHash = status.optString("hash").ifEmpty { status.optString("latestHash") }
        if (latestHash.isEmpty() || !status.has("difficulty")) {
            MiningState.solver = "no work template"
            MiningState.note = "Tip JSON had no hash or difficulty. The search was not run."
            MiningState.lastSubmission = "not submitted"
            return Result.retry()
        }
        val difficulty = status.getLong("difficulty")
        val height = status.getInt("height")
        val mempoolPressure = status.optDouble("mempoolPressure", 0.0)
        val cumulativeWork = difficulty * height.toLong()
        MiningState.httpHeight = height.toString()
        if (MiningState.httpTipSource == "—" || MiningState.httpTipSource == "none") {
            MiningState.httpTipSource = "HTTP"
        }
        MiningState.note = ""

        if (P2PNode.isRunning() && latestHash.isNotEmpty()) {
            P2PNode.setLocalTip(height.toLong(), latestHash, difficulty)
        }
        if (tryAdoptPeerBlock()) return Result.success()

        val prevHashBytes = hexToByteArray(latestHash)
        val merkleRootBytes = ByteArray(32)
        val timestamp = System.currentTimeMillis() / 1000L
        val outNonce = arrayOf("")
        val outResidual = LongArray(1)

        MiningState.solver = "running"
        MiningState.searches += 1
        val solved = solveBlock.solveBlock(
            prevHashBytes, merkleRootBytes,
            timestamp, difficulty,
            2, mempoolPressure, cumulativeWork,
            MAX_SOLVER_ATTEMPTS, outNonce, outResidual,
        )
        if (!solved) {
            MiningState.solver = "idle"
            MiningState.lastSolution = "none this search"
            return Result.success()
        }

        val nonce = outNonce[0]
        if (!isU64Decimal(nonce)) {
            Log.e(TAG, "Solver nonce is not a u64: $nonce")
            MiningState.solver = "bad nonce"
            MiningState.lastSolution = "rejected"
            return Result.failure(workDataOf("error" to "nonce is not a u64"))
        }
        val residualFp = outResidual[0]
        val residual = residualFp.toDouble() / RESIDUAL_SCALE
        MiningState.solutions += 1
        MiningState.lastSolution = "nonce $nonce"
        MiningState.solver = "idle"
        Log.i(TAG, "Solution found: nonce=$nonce residual=$residual (fixed-point=$residualFp)")

        if (tryAdoptPeerBlock()) {
            MiningState.lastSubmission = "discarded, peer won"
            return Result.success()
        }

        val unknownRoot = "0".repeat(64)
        val blockHash = canonicalHeaderHash(
            prevHash = latestHash,
            merkleRoot = unknownRoot,
            stateRoot = unknownRoot,
            timestamp = timestamp,
            nonce = nonce,
            difficulty = difficulty,
            residualFp = residualFp,
            miner = minerAddress,
            height = height + 1,
            pressure = 0.0,
        )
        val blockBodyJson = buildBlockBodyJson(
            hash = blockHash,
            height = height + 1,
            prevHash = hex64(latestHash),
            nonce = nonce,
            residual = residual,
            residualFp = residualFp,
            timestamp = timestamp,
            miner = minerAddress,
            difficulty = difficulty,
            merkleRoot = unknownRoot,
            stateRoot = unknownRoot,
        )

        val hasPeers = P2PNode.isRunning() && P2PNode.getConnectedPeerCount() > 0
        if (hasPeers) {
            val bodySent = P2PNode.gossipBlockBody(blockBodyJson)
            val hashSent = P2PNode.gossipBlock(blockHash)
            if (bodySent && hashSent) {
                val accepted = validateAndAwaitAccept(blockBodyJson, fromPeer = false)
                if (accepted != null) {
                    val tipHash = accepted.ifEmpty { blockHash }
                    P2PNode.setLocalTip((height + 1).toLong(), tipHash, difficulty)
                    P2PNode.pushBlockBody(blockBodyJson)
                    MiningState.lastSubmission = "accepted on peer path"
                    MiningState.httpHeight = (height + 1).toString()
                    return Result.success()
                }
                MiningState.lastSubmission = "local validation refused"
            } else {
                MiningState.lastSubmission = "gossip failed"
            }
        }

        val httpSubmitEnabled = when (System.getenv("HTTP_SUBMIT")?.lowercase()) {
            "1", "true", "on" -> true
            "0", "false", "off" -> false
            else -> !hasPeers
        }
        if (!httpSubmitEnabled) {
            if (MiningState.lastSubmission == "—") {
                MiningState.lastSubmission = if (hasPeers) "peers present, HTTP skipped" else "HTTP submit off"
            }
            return Result.success()
        }
        return submitBlock(
            nodeUrl = nodeUrl,
            miner = minerAddress,
            prevHash = latestHash,
            nonce = nonce,
            residual = residual,
            timestamp = timestamp,
            difficulty = difficulty,
            blockBodyJson = blockBodyJson,
        )
    }

    private fun noteLightOnly(nodeUrl: String) {
        val light = fetchLight(nodeUrl)
        if (light != null) {
            MiningState.httpHeight = light.toString()
            MiningState.httpTipSource = "HTTP"
            MiningState.solver = "no work template"
            MiningState.lastSubmission = "not submitted"
            MiningState.note = "Height $light is from /api/light. This host has no /api/chain/status, so the search was not run."
        } else {
            MiningState.solver = "no tip"
            MiningState.httpTipSource = "none"
            MiningState.lastSubmission = "not submitted"
            MiningState.note = "No /api/chain/status and no /api/light from $nodeUrl."
        }
    }

    private fun tryAdoptPeerBlock(): Boolean {
        if (!P2PNode.isRunning()) return false
        val competingHash = P2PNode.pollGossip()
        if (competingHash.isEmpty()) return false
        val body = P2PNode.querySyncBlock(competingHash)
        if (body.isEmpty()) return true
        val acceptedHash = validateAndAwaitAccept(body, fromPeer = true) ?: return true
        val obj = runCatching { JSONObject(body) }.getOrNull()
        val h = obj?.optLong("height", -1L) ?: -1L
        val hash = acceptedHash.ifEmpty {
            obj?.optString("hash")?.ifEmpty { competingHash } ?: competingHash
        }
        val diff = obj?.optLong("difficulty", 0L) ?: 0L
        if (h >= 0 && hash.isNotEmpty()) {
            P2PNode.setLocalTip(h, hash, diff)
            P2PNode.pushBlockBody(body)
            MiningState.httpHeight = h.toString()
            MiningState.httpTipSource = "P2P"
        }
        return true
    }

    private fun validateAndAwaitAccept(blockBodyJson: String, fromPeer: Boolean): String? {
        if (P2PNode.isRunning()) P2PNode.startValidator()
        if (!P2PNode.shouldValidateNow()) return null
        if (!P2PNode.submitBlockForValidation(blockBodyJson, fromPeer)) return null
        val deadline = System.currentTimeMillis() + VALIDATION_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val raw = P2PNode.getValidationResult()
            if (raw.isNotEmpty()) {
                val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
                return when (json.optString("status")) {
                    "accept" -> json.optString("hash")
                    else -> null
                }
            }
            try {
                Thread.sleep(VALIDATION_POLL_MS)
            } catch (_: InterruptedException) {
                return null
            }
        }
        return null
    }

    private fun fetchChainStatus(nodeUrl: String): JSONObject? {
        val request = Request.Builder().url("$nodeUrl/api/chain/status").get().build()
        return try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val json = JSONObject(response.body!!.string())
                MiningState.httpTipSource = "HTTP"
                json
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Height only. Not a work template. */
    private fun fetchLight(nodeUrl: String): Int? {
        val request = Request.Builder()
            .url("$nodeUrl/api/light?network=testnet")
            .get()
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val height = JSONObject(response.body!!.string()).optInt("height", -1)
                height.takeIf { it >= 0 }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun submitBlock(
        nodeUrl: String,
        miner: String,
        prevHash: String,
        nonce: String,
        residual: Double,
        timestamp: Long,
        difficulty: Long,
        blockBodyJson: String,
    ): Result {
        val payload = JSONObject().apply {
            put("miner", miner)
            put("prevHash", prevHash)
            put("nonce", nonce)
            put("residual", residual)
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
                        val blockHash = json?.optString("hash") ?: ""
                        if (blockHash.isNotEmpty() && acceptedHeight >= 0) {
                            P2PNode.setLocalTip(acceptedHeight.toLong(), blockHash, difficulty)
                            MiningState.httpHeight = acceptedHeight.toString()
                        }
                        if (blockHash.isNotEmpty() && P2PNode.isRunning()) P2PNode.gossipBlock(blockHash)
                        if (P2PNode.isRunning() && blockBodyJson.isNotEmpty()) P2PNode.gossipBlockBody(blockBodyJson)
                        MiningState.lastSubmission = "accepted height $acceptedHeight"
                        Result.success(workDataOf(
                            "accepted_height" to acceptedHeight,
                            "block_hash" to blockHash,
                            "reward" to (json?.optLong("reward") ?: 0L),
                        ))
                    }
                    response.code == 409 -> {
                        MiningState.lastSubmission = "stale"
                        Result.success()
                    }
                    response.code == 422 -> {
                        MiningState.lastSubmission = "residual refused"
                        Result.success()
                    }
                    response.code in 400..499 -> {
                        MiningState.lastSubmission = "HTTP ${response.code}"
                        Result.failure(workDataOf("error" to "HTTP ${response.code}: $body"))
                    }
                    else -> {
                        MiningState.lastSubmission = "HTTP ${response.code}, will retry"
                        Result.retry()
                    }
                }
            }
        } catch (e: IOException) {
            MiningState.lastSubmission = e.message ?: "network error"
            Result.retry()
        } catch (e: Exception) {
            MiningState.lastSubmission = e.message ?: "submit failed"
            Result.failure(workDataOf("error" to (e.message ?: "unknown")))
        }
    }

    private fun canonicalHeaderHash(
        prevHash: String,
        merkleRoot: String,
        stateRoot: String,
        timestamp: Long,
        nonce: String,
        difficulty: Long,
        residualFp: Long,
        miner: String,
        height: Int,
        pressure: Double,
    ): String {
        val pressureText = String.format(Locale.US, "%.6f", pressure)
        val preimage = "${hex64(prevHash)}|${hex64(merkleRoot)}|${hex64(stateRoot)}|$timestamp|$nonce|$difficulty|$residualFp|$miner|$height|$pressureText"
        val md = java.security.MessageDigest.getInstance("SHA-256")
        val first = md.digest(preimage.toByteArray(Charsets.UTF_8))
        return md.digest(first).joinToString("") { "%02x".format(it) }
    }

    private fun hex64(hex: String): String {
        val clean = if (hex.startsWith("0x", ignoreCase = true)) hex.substring(2) else hex
        return clean.padStart(64, '0').takeLast(64).lowercase()
    }

    private fun buildBlockBodyJson(
        hash: String,
        height: Int,
        prevHash: String,
        nonce: String,
        residual: Double,
        residualFp: Long,
        timestamp: Long,
        miner: String,
        difficulty: Long,
        merkleRoot: String,
        stateRoot: String,
    ): String = JSONObject().apply {
        put("hash", hash)
        put("height", height)
        put("prevHash", prevHash)
        put("nonce", nonce)
        put("residual", residual)
        put("residualFp", residualFp)
        put("timestamp", timestamp)
        put("miner", miner)
        put("difficulty", difficulty)
        put("merkleRoot", merkleRoot)
        put("stateRoot", stateRoot)
    }.toString()

    private fun isU64Decimal(text: String): Boolean {
        if (text == "0") return true
        if (text.isEmpty() || text[0] == '0') return false
        if (text.length > 20 || text.any { it !in '0'..'9' }) return false
        return text.length < 20 || text <= "18446744073709551615"
    }

    private fun hexToByteArray(hex: String): ByteArray {
        val clean = if (hex.startsWith("0x", ignoreCase = true)) hex.substring(2) else hex
        val padded = clean.padStart(64, '0').takeLast(64)
        return ByteArray(32) { i ->
            padded.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    }

    private companion object {
        const val TAG = "MiningCycle"
        const val MAX_SOLVER_ATTEMPTS = 500_000L
        const val RESIDUAL_SCALE = 1_000_000_000_000_000_000.0
        const val VALIDATION_POLL_MS = 50L
        const val VALIDATION_TIMEOUT_MS = 8_000L
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
