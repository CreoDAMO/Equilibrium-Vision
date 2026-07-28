package com.equilibrium

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.zxing.BarcodeFormat
import com.google.zxing.integration.android.IntentIntegrator
import com.google.zxing.integration.android.IntentResult
import com.journeyapps.barcodescanner.BarcodeEncoder
import java.net.NetworkInterface

/**
 * BootstrapQrActivity — first-contact UI for joining the Equilibrium mesh.
 *
 * Three ways to connect to a peer:
 *   1. **Show QR**  — displays this node's invite URI as a QR code; other
 *      phones scan it to connect back to you.
 *   2. **Scan QR**  — opens the camera (via ZXing IntentIntegrator) to read a
 *      peer's invite QR and auto-fills the address field.
 *   3. **Share**    — sends the invite URI via any installed share-sheet app
 *      (Messages, email, etc.).
 *   4. **Manual**   — paste or type a multiaddr / equilibrium:// URI directly.
 *
 * Invite URI format:  equilibrium://bootstrap?addr=%2Fip4%2F<ip>%2Ftcp%2F9000
 * Also accepts raw libp2p multiaddrs:  /ip4/192.168.1.5/tcp/9000/p2p/QmPeer…
 */
class BootstrapQrActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "BootstrapQr"
        /** Intent extra: pre-fill the address field (e.g. from an NFC tag). */
        const val EXTRA_PREFILL_ADDR = "prefill_addr"
    }

    private lateinit var addrInput: EditText
    private lateinit var statusView: TextView
    private lateinit var qrImage: ImageView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_bootstrap_qr)

        addrInput   = findViewById(R.id.addrInput)
        statusView  = findViewById(R.id.statusView)
        qrImage     = findViewById(R.id.qrImage)

        // Pre-fill if launched from NFC tap / deep link
        intent.getStringExtra(EXTRA_PREFILL_ADDR)?.let { addrInput.setText(it) }

        // Show this node's invite QR immediately
        showMyQr()

        findViewById<Button>(R.id.shareBtn).setOnClickListener   { shareInvite() }
        findViewById<Button>(R.id.scanBtn).setOnClickListener    { launchScanner() }
        findViewById<Button>(R.id.connectBtn).setOnClickListener { onConnectClicked() }
    }

    // ── QR generation ─────────────────────────────────────────────────────────

    private fun buildMyInviteUri(): String {
        val ip = getLocalIpv4() ?: "0.0.0.0"
        val multiaddr = "/ip4/$ip/tcp/9000"
        return "equilibrium://bootstrap?addr=" + Uri.encode(multiaddr)
    }

    /**
     * Walk NetworkInterface to find the first non-loopback IPv4 address.
     * Returns null if the device has no network or only loopback.
     */
    private fun getLocalIpv4(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces()?.toList()
            ?.flatMap { it.inetAddresses?.toList() ?: emptyList() }
            ?.firstOrNull { addr ->
                !addr.isLoopbackAddress &&
                    addr.hostAddress?.let { it.contains('.') && !it.startsWith("169.254") } == true
            }
            ?.hostAddress
    }.getOrNull()

    private fun showMyQr() {
        val uri = buildMyInviteUri()
        runCatching {
            val bitmap: Bitmap = BarcodeEncoder().encodeBitmap(uri, BarcodeFormat.QR_CODE, 512, 512)
            qrImage.setImageBitmap(bitmap)
        }.onFailure {
            // JNI libs absent in emulator/dev builds — show nothing rather than crash.
            qrImage.setImageDrawable(null)
        }
    }

    // ── Share ─────────────────────────────────────────────────────────────────

    private fun shareInvite() {
        val uri = buildMyInviteUri()
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, uri)
            putExtra(Intent.EXTRA_SUBJECT, getString(R.string.share_invite_subject))
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.share_invite_chooser)))
    }

    // ── QR scanning ───────────────────────────────────────────────────────────

    private fun launchScanner() {
        IntentIntegrator(this).apply {
            setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            setPrompt(getString(R.string.scan_prompt))
            setCameraId(0)
            setBeepEnabled(false)
            setBarcodeImageEnabled(false)
            initiateScan()
        }
    }

    @Deprecated("Using deprecated onActivityResult for ZXing IntentIntegrator compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val result: IntentResult =
            IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result.contents != null) {
            addrInput.setText(result.contents)
            onConnectClicked()
        } else {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    // ── Deep-link ─────────────────────────────────────────────────────────────

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.takeIf { it.startsWith("equilibrium://") }?.let { uri ->
            setIntent(intent.putExtra(EXTRA_PREFILL_ADDR, uri))
        }
    }

    // ── Manual connect ────────────────────────────────────────────────────────

    private fun onConnectClicked() {
        val raw = addrInput.text?.toString()?.trim() ?: return
        if (raw.isEmpty()) {
            statusView.text = getString(R.string.error_empty_addr)
            return
        }
        if (!P2PNode.isRunning()) {
            val started = P2PNode.startDefault()
            if (!started) {
                statusView.text = getString(R.string.error_p2p_start)
                return
            }
        }
        val ok = P2PNode.connectInvite(raw)
        statusView.text = if (ok) getString(R.string.connect_success)
                          else    getString(R.string.connect_invalid)
    }
}
