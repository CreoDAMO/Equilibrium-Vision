package com.equilibrium

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.google.android.material.button.MaterialButton
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * MainActivity — landing screen for the sideloaded miner app.
 *
 * Features added in this revision:
 *   - **P2P mode toggle** — choose HTTP-only, Hybrid (P2P + HTTP fallback), or
 *     P2P-only.  The selection persists in SharedPreferences and controls
 *     whether the in-process libp2p swarm starts on launch.
 *   - **Live network status** — height, peer count, tip source, and last gossip
 *     hash polled every 3 seconds from P2PNode.
 *   - **Join Network button** — opens BootstrapQrActivity for QR display,
 *     QR scan, and share-sheet invite flow.
 */
class MainActivity : AppCompatActivity() {

    // ── Update checker ────────────────────────────────────────────────────────
    private lateinit var updateChecker: UpdateChecker
    private lateinit var updateStatus: TextView
    private lateinit var updateProgress: ProgressBar

    // ── Mining / network status ───────────────────────────────────────────────
    private lateinit var statusHeight: TextView
    private lateinit var statusPeers: TextView
    private lateinit var statusTipSource: TextView
    private lateinit var statusLastGossip: TextView
    private lateinit var statusMining: TextView
    private lateinit var statusSolver: TextView
    private lateinit var statusSearches: TextView
    private lateinit var statusSolutions: TextView
    private lateinit var statusLastSolution: TextView
    private lateinit var statusLastSubmission: TextView
    private lateinit var statusMiningNote: TextView
    private lateinit var mineButton: MaterialButton

    private val handler = Handler(Looper.getMainLooper())
    private var lightPoll = false
    private companion object {
        const val POLL_INTERVAL_MS = 3_000L
        const val PREFS_NAME       = "equ_prefs"
        const val KEY_P2P_MODE     = "p2p_mode"
        const val KEY_NODE_URL     = "node_url"
        const val KEY_MINER        = "miner_address"
        const val MODE_HTTP        = "http"
        const val MODE_HYBRID      = "hybrid"
        const val MODE_P2P         = "p2p"
    }

    private val statusPoller = object : Runnable {
        override fun run() {
            refreshNetworkStatus()
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Update checks use GitHub Releases, not the mining node.
        updateChecker = UpdateChecker()
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

        // Version label
        findViewById<TextView>(R.id.versionLabel).text = getString(
            R.string.current_version,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
        )

        // Update-check views
        updateStatus   = findViewById(R.id.updateStatus)
        updateProgress = findViewById(R.id.updateProgress)

        // Network-status views
        statusHeight     = findViewById(R.id.statusHeight)
        statusPeers      = findViewById(R.id.statusPeers)
        statusTipSource  = findViewById(R.id.statusTipSource)
        statusLastGossip = findViewById(R.id.statusLastGossip)
        statusMining     = findViewById(R.id.statusMining)
        statusSolver     = findViewById(R.id.statusSolver)
        statusSearches   = findViewById(R.id.statusSearches)
        statusSolutions  = findViewById(R.id.statusSolutions)
        statusLastSolution = findViewById(R.id.statusLastSolution)
        statusLastSubmission = findViewById(R.id.statusLastSubmission)
        statusMiningNote = findViewById(R.id.statusMiningNote)
        mineButton       = findViewById(R.id.mineButton)

        val siteInput = findViewById<EditText>(R.id.siteUrlInput)
        val minerInput = findViewById<EditText>(R.id.minerAddressInput)
        siteInput.setText(prefs.getString(KEY_NODE_URL, null) ?: getString(R.string.site_url_hint))
        prefs.getString(KEY_MINER, null)?.let { minerInput.setText(it) }
        if (Build.VERSION.SDK_INT >= 33 &&
            ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
        mineButton.setOnClickListener {
            if (MiningState.mining == "active") {
                MiningService.stop(this)
                return@setOnClickListener
            }
            val miner = MiningWorker.normalizeMinerAddress(minerInput.text.toString())
            val node = siteInput.text.toString().trim().trimEnd('/').ifEmpty { MiningWorker.DEFAULT_NODE_URL }
            siteInput.setText(node)
            if (miner == null) {
                MiningState.mining = "stopped"
                MiningState.solver = "miner address required"
                MiningState.note = getString(R.string.miner_address_required)
                refreshNetworkStatus()
                return@setOnClickListener
            }
            prefs.edit().putString(KEY_MINER, miner).putString(KEY_NODE_URL, node).apply()
            val mode = prefs.getString(KEY_P2P_MODE, MODE_HYBRID)
            if (mode != MODE_HTTP && !P2PNode.isRunning()) {
                P2PNode.startDefaultWithContext(this)
            }
            MiningService.start(this, node, miner)
        }

        // ── P2P mode toggle ───────────────────────────────────────────────────
        val savedMode = prefs.getString(KEY_P2P_MODE, MODE_HYBRID) ?: MODE_HYBRID
        val modeGroup = findViewById<RadioGroup>(R.id.p2pModeGroup)
        when (savedMode) {
            MODE_HTTP -> modeGroup.check(R.id.modeHttp)
            MODE_P2P  -> modeGroup.check(R.id.modeP2p)
            else      -> modeGroup.check(R.id.modeHybrid)
        }
        modeGroup.setOnCheckedChangeListener { _, checkedId ->
            val mode = when (checkedId) {
                R.id.modeHttp -> MODE_HTTP
                R.id.modeP2p  -> MODE_P2P
                else          -> MODE_HYBRID
            }
            prefs.edit().putString(KEY_P2P_MODE, mode).apply()
            // Start P2P swarm immediately when switching away from HTTP-only
            if (mode != MODE_HTTP && !P2PNode.isRunning()) {
                P2PNode.startDefaultWithContext(this)
            }
        }

        // Auto-start P2P unless in HTTP-only mode
        if (savedMode != MODE_HTTP && !P2PNode.isRunning()) {
            P2PNode.startDefaultWithContext(this)
        }

        // ── Start embedded node button ────────────────────────────────────────
        val bootstrapInput = findViewById<EditText>(R.id.bootstrapInput)
        findViewById<MaterialButton>(R.id.startNodeButton).setOnClickListener {
            val started = P2PNode.startDefaultWithContext(this)
            updateStatus.text = if (started) getString(R.string.p2p_started)
                                 else        getString(R.string.p2p_already_started)
        }

        // ── Direct bootstrap connect ──────────────────────────────────────────
        findViewById<MaterialButton>(R.id.connectBootstrapButton).setOnClickListener {
            val connected = P2PNode.connectInvite(bootstrapInput.text.toString())
            updateStatus.text = if (connected) getString(R.string.bootstrap_connecting)
                                 else          getString(R.string.bootstrap_invalid)
        }

        // ── Join network (QR / share) ─────────────────────────────────────────
        findViewById<MaterialButton>(R.id.joinNetworkBtn).setOnClickListener {
            startActivity(Intent(this, BootstrapQrActivity::class.java))
        }

        // Same packet the website serves: continuity, residual, merkle, header.
        // This activity does not search for a nonce.
        findViewById<MaterialButton>(R.id.verifySiteButton).setOnClickListener {
            val base = findViewById<EditText>(R.id.siteUrlInput).text.toString().trim().trimEnd('/')
            val lightStatus = findViewById<TextView>(R.id.lightStatus)
            if (base.isEmpty()) {
                lightStatus.text = getString(R.string.light_need_url)
                return@setOnClickListener
            }
            lightStatus.text = getString(R.string.checking_updates)
            Thread {
                try {
                    val conn = (URL("$base/api/light?network=testnet").openConnection() as HttpURLConnection).apply {
                        connectTimeout = 8000
                        readTimeout = 8000
                        requestMethod = "GET"
                    }
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(text)
                    val agree = json.optJSONObject("bidirectional")?.optBoolean("agree") ?: false
                    val checks = json.optJSONArray("checks")
                    var pass = 0
                    val total = checks?.length() ?: 0
                    if (checks != null) {
                        for (i in 0 until checks.length()) {
                            if (checks.getJSONObject(i).optBoolean("ok")) pass++
                        }
                    }
                    val line = getString(
                        R.string.light_result,
                        json.optInt("height"),
                        if (agree) "agree" else "diverge",
                        pass,
                        total,
                    )
                    handler.post { lightStatus.text = line }
                } catch (e: Exception) {
                    handler.post { lightStatus.text = getString(R.string.light_failed, e.message ?: "error") }
                }
            }.start()
        }

        // ── Update check ──────────────────────────────────────────────────────
        findViewById<MaterialButton>(R.id.checkUpdatesButton).setOnClickListener {
            checkForUpdates()
        }
        checkForUpdates()

        // Handle deep-link launch (equilibrium:// URI)
        handleIncomingIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        handler.post(statusPoller)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(statusPoller)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let { handleIncomingIntent(it) }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(statusPoller)
    }

    // ── Network status polling ────────────────────────────────────────────────

    private fun refreshNetworkStatus() {
        val p2p = P2PNode.isRunning()
        val tipJson = if (p2p) P2PNode.fetchTip() else ""
        val showedP2p = tipJson.isNotEmpty() && runCatching {
            val obj = JSONObject(tipJson)
            val height = obj.optLong("height", 0)
            val hash = obj.optString("hash", "").take(16)
            statusHeight.text = "Height: $height  (${hash}…)"
            statusTipSource.text = "Tip source: P2P cache"
            true
        }.getOrElse { false }
        if (!showedP2p) {
            if (MiningState.httpHeight != "—") {
                statusHeight.text = "Height: ${MiningState.httpHeight}"
                statusTipSource.text = "Tip source: ${MiningState.httpTipSource}"
            } else {
                statusHeight.text = getString(R.string.status_height_default)
                statusTipSource.text = getString(R.string.status_tip_source_default)
            }
            refreshLightHeight()
        }
        statusPeers.text = if (p2p) "Peers: ${P2PNode.getConnectedPeerCount()}" else getString(R.string.status_peers_default)
        if (p2p) {
            val gossip = P2PNode.pollGossip()
            if (gossip.isNotEmpty()) statusLastGossip.text = "Last gossip: ${gossip.take(16)}…"
        }
        statusMining.text = "Mining: ${MiningState.mining}"
        statusSolver.text = "Solver: ${MiningState.solver}"
        statusSearches.text = "Searches: ${MiningState.searches}"
        statusSolutions.text = "Solutions: ${MiningState.solutions}"
        statusLastSolution.text = "Last solution: ${MiningState.lastSolution}"
        statusLastSubmission.text = "Last submission: ${MiningState.lastSubmission}"
        statusMiningNote.text = MiningState.note
        mineButton.text = getString(
            if (MiningState.mining == "active") R.string.stop_mining else R.string.start_mining,
        )
    }

    private fun refreshLightHeight() {
        if (lightPoll) return
        val base = findViewById<EditText>(R.id.siteUrlInput).text.toString().trim().trimEnd('/')
        if (base.isEmpty()) return
        lightPoll = true
        Thread {
            try {
                val conn = (URL("$base/api/light?network=testnet").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 8000
                    requestMethod = "GET"
                }
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val height = JSONObject(text).optInt("height", -1)
                if (height >= 0) {
                    MiningState.httpHeight = height.toString()
                    if (MiningState.httpTipSource == "—" || MiningState.httpTipSource == "none") {
                        MiningState.httpTipSource = "HTTP"
                    }
                }
            } catch (_: Exception) {
            } finally {
                lightPoll = false
            }
        }.start()
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun handleIncomingIntent(intent: Intent) {
        val data = intent.data ?: return
        if (data.scheme == "equilibrium" && data.host == "wallet") {
            val miner = MiningWorker.normalizeMinerAddress(data.getQueryParameter("address"))
            if (miner == null) {
                updateStatus.text = getString(R.string.wallet_address_refused)
                return
            }
            findViewById<EditText>(R.id.minerAddressInput).setText(miner)
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putString(KEY_MINER, miner).apply()
            updateStatus.text = getString(R.string.wallet_address_linked)
            return
        }
        val invite = data.toString()
        if (invite.startsWith("equilibrium://") || invite.startsWith("/")) {
            val connected = P2PNode.connectInvite(invite)
            updateStatus.text = if (connected) getString(R.string.bootstrap_connecting)
                                 else          getString(R.string.bootstrap_invalid)
        }
    }

    private fun checkForUpdates() {
        updateProgress.visibility = View.VISIBLE
        updateStatus.text = getString(R.string.checking_updates)

        updateChecker.checkForUpdate(BuildConfig.VERSION_CODE) { result ->
            runOnUiThread {
                updateProgress.visibility = View.GONE
                when (result) {
                    is UpdateCheckResult.UpToDate ->
                        updateStatus.text = getString(R.string.up_to_date, result.currentVersionName)
                    is UpdateCheckResult.UpdateAvailable -> {
                        updateStatus.text = ""
                        showUpdateDialog(result)
                    }
                    is UpdateCheckResult.Error ->
                        updateStatus.text = getString(R.string.update_check_failed, result.message)
                }
            }
        }
    }

    private fun showUpdateDialog(update: UpdateCheckResult.UpdateAvailable) {
        AlertDialog.Builder(this)
            .setTitle(R.string.update_available_title)
            .setMessage(
                getString(
                    R.string.update_available_message,
                    update.versionName,
                    BuildConfig.VERSION_NAME,
                    update.releaseNotes ?: "",
                )
            )
            .setPositiveButton(R.string.download_button) { _, _ ->
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(update.downloadUrl)))
            }
            .setNegativeButton(R.string.later_button, null)
            .show()
    }
}
