package com.equilibrium

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import org.json.JSONObject

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

    private val handler = Handler(Looper.getMainLooper())
    private companion object {
        const val POLL_INTERVAL_MS = 3_000L
        const val PREFS_NAME       = "equ_prefs"
        const val KEY_P2P_MODE     = "p2p_mode"
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

        // UpdateChecker now queries the GitHub Releases API directly —
        // no dependency on the mining node URL (which defaults to the
        // Android-emulator-only 10.0.2.2 address and is useless on real phones).
        updateChecker = UpdateChecker()

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

        // ── P2P mode toggle ───────────────────────────────────────────────────
        val prefs    = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
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
        if (!P2PNode.isRunning()) {
            statusHeight.text     = getString(R.string.status_height_default)
            statusPeers.text      = getString(R.string.status_peers_default)
            statusTipSource.text  = getString(R.string.status_tip_source_default)
            return
        }

        val tipJson   = P2PNode.fetchTip()
        val peerCount = P2PNode.getConnectedPeerCount()
        val gossip    = P2PNode.pollGossip()

        if (tipJson.isNotEmpty()) {
            runCatching {
                val obj    = JSONObject(tipJson)
                val height = obj.optLong("height", 0)
                val hash   = obj.optString("hash", "").take(16)
                statusHeight.text    = "Height: $height  (${hash}…)"
                statusTipSource.text = "Tip source: P2P cache"
            }.onFailure {
                statusHeight.text    = "Height: —"
                statusTipSource.text = "Tip source: unknown"
            }
        } else {
            statusHeight.text    = getString(R.string.status_height_default)
            statusTipSource.text = "Tip source: HTTP fallback"
        }

        statusPeers.text = "Peers: $peerCount"

        if (gossip.isNotEmpty()) {
            statusLastGossip.text = "Last gossip: ${gossip.take(16)}…"
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun handleIncomingIntent(intent: Intent) {
        val invite = intent.data?.toString() ?: return
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
