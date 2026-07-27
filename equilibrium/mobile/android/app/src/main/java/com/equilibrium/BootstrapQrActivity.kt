package com.equilibrium

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.*

/**
 * BootstrapQrActivity — first-contact UI for joining the Equilibrium mesh.
 *
 * Accepts a bootstrap invite in any of these formats:
 *   - Raw libp2p multiaddr:  /ip4/192.168.1.5/tcp/9000/p2p/QmPeer...
 *   - Equilibrium invite URI: equilibrium://bootstrap?addr=%2Fip4%2F...
 *
 * Both formats can be encoded as a QR code or NFC NDEF payload.
 * This activity provides a manual-entry path; QR camera scanning requires
 * an additional library (e.g. ZXing / ML Kit) and is left as a follow-up
 * integration — see TODO.md §1.
 *
 * Usage from other activities:
 *   startActivity(Intent(this, BootstrapQrActivity::class.java))
 */
class BootstrapQrActivity : Activity() {

    companion object {
        private const val TAG = "BootstrapQr"
        /** Intent extra: pre-fill the address field (e.g. from an NFC tag). */
        const val EXTRA_PREFILL_ADDR = "prefill_addr"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // ── Build layout programmatically (no XML resource dependency) ────────
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity     = Gravity.CENTER_HORIZONTAL
            setPadding(48, 64, 48, 48)
        }

        val title = TextView(this).apply {
            text     = "Connect to Peer"
            textSize = 20f
            gravity  = Gravity.CENTER
        }
        root.addView(title)

        val sub = TextView(this).apply {
            text     = "Enter a multiaddr or equilibrium://bootstrap?addr=… invite"
            textSize = 13f
            gravity  = Gravity.CENTER
            setPadding(0, 16, 0, 24)
        }
        root.addView(sub)

        val addrInput = EditText(this).apply {
            hint        = "/ip4/…/tcp/9000/p2p/Qm…"
            isSingleLine = false
            minLines    = 2
            maxLines    = 4
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        // Pre-fill if launched from NFC tap / deep link
        intent.getStringExtra(EXTRA_PREFILL_ADDR)?.let { addrInput.setText(it) }
        root.addView(addrInput)

        val statusView = TextView(this).apply {
            text    = ""
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 0)
        }

        val connectBtn = Button(this).apply {
            text = "Connect"
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = 24 }
            setOnClickListener { onConnectClicked(addrInput, statusView) }
        }
        root.addView(connectBtn)
        root.addView(statusView)

        // ── QR scanner placeholder ────────────────────────────────────────────
        val qrNote = TextView(this).apply {
            text     = "📷  QR camera scanning: add ZXing/ML Kit dependency and launch\n" +
                       "a barcode scanner Intent here — see BootstrapQrActivity TODO."
            textSize = 11f
            gravity  = Gravity.CENTER
            setPadding(0, 32, 0, 0)
            alpha   = 0.55f
        }
        root.addView(qrNote)

        setContentView(root)
    }

    /** Handle deep-links: activity can be started with an equilibrium:// URI. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.takeIf { it.startsWith("equilibrium://") }?.let { uri ->
            // The address field may not exist yet if onCreate hasn't run —
            // store it so onCreate can prefill it via the extra.
            setIntent(intent.putExtra(EXTRA_PREFILL_ADDR, uri))
        }
    }

    private fun onConnectClicked(addrInput: EditText, statusView: TextView) {
        val raw = addrInput.text?.toString()?.trim() ?: return
        if (raw.isEmpty()) {
            statusView.text = "⚠ Enter a multiaddr or invite URI."
            return
        }

        // Ensure the swarm is running before dialing.
        if (!P2PNode.isRunning()) {
            val started = P2PNode.startDefault()
            Log.i(TAG, "Started P2P swarm: $started")
            if (!started) {
                statusView.text = "⚠ Could not start P2P swarm."
                return
            }
        }

        val ok = P2PNode.connectInvite(raw)
        if (ok) {
            Log.i(TAG, "Dialled: $raw")
            statusView.text = "✓ Dial request sent. Peer will appear once connected."
        } else {
            Log.w(TAG, "Invalid invite: $raw")
            statusView.text = "✗ Invalid multiaddr or invite URI."
        }
    }
}
