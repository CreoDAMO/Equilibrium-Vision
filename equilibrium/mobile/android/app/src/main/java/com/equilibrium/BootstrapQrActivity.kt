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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import com.journeyapps.barcodescanner.BarcodeEncoder
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * BootstrapQrActivity — first-contact UI for joining the Equilibrium mesh.
 *
 * Three ways to connect to a peer:
 *   1. **Show QR**  — displays this node's complete invite URI as a QR code;
 *      the URI includes the PeerId so the scanning phone authenticates via noise.
 *   2. **Scan QR**  — opens the camera (via ZXing ScanContract) to read a
 *      peer's invite QR and auto-fills the address field.
 *   3. **Share**    — sends the invite URI via any installed share-sheet app.
 *   4. **Manual**   — paste or type a multiaddr / equilibrium:// URI directly.
 *
 * Invite URI format:
 *   equilibrium://bootstrap?addr=%2Fip4%2F<ip>%2Ftcp%2F9000%2Fp2p%2F<peerId>
 *
 * Also accepts raw libp2p multiaddrs:
 *   /ip4/192.168.1.5/tcp/9000/p2p/QmPeer…
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

    // ── ZXing ScanContract (replaces deprecated IntentIntegrator) ─────────────
    //
    // registerForActivityResult must be called before onCreate returns, which is
    // why it is declared as a property initialiser here.
    private val barcodeLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        val scanned = result.contents
        if (scanned != null) {
            addrInput.setText(scanned)
            onConnectClicked()
        }
        // Cancelled / no camera permission — do nothing; user already sees the UI.
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_bootstrap_qr)

        addrInput   = findViewById(R.id.addrInput)
        statusView  = findViewById(R.id.statusView)
        qrImage     = findViewById(R.id.qrImage)

        // Pre-fill if launched from NFC tap / deep link
        intent.getStringExtra(EXTRA_PREFILL_ADDR)?.let { addrInput.setText(it) }

        // Show this node's invite QR immediately (shows placeholder/error if P2P not running)
        showMyQr()

        findViewById<Button>(R.id.shareBtn).setOnClickListener   { shareInvite() }
        findViewById<Button>(R.id.scanBtn).setOnClickListener    { launchScanner() }
        findViewById<Button>(R.id.connectBtn).setOnClickListener { onConnectClicked() }
    }

    override fun onResume() {
        super.onResume()
        // Refresh QR once the user returns from MainActivity (P2P may have started).
        showMyQr()
    }

    // ── QR generation ─────────────────────────────────────────────────────────

    /**
     * Build the invite URI for this node.
     *
     * Format: `equilibrium://bootstrap?addr=<url-encoded multiaddr>`
     * Multiaddr: `/ip4/<localIP>/tcp/9000/p2p/<peerId>`
     *
     * Returns an empty string and updates [statusView] on any error so that
     * callers can check `uri.isEmpty()` without separate error handling.
     */
    private fun buildMyInviteUri(): String {
        val ip = getLocalIpv4()
        if (ip == null) {
            statusView.text = getString(R.string.error_no_wifi)
            return ""
        }

        if (!P2PNode.isRunning()) {
            statusView.text = getString(R.string.error_p2p_not_started)
            return ""
        }

        // Wrap in runCatching: getLocalPeerId() requires libequilibrium_core.so to
        // have been rebuilt with the new JNI symbol.  An old .so will throw
        // UnsatisfiedLinkError at call-time; treat that the same as "not ready yet".
        val peerId = runCatching { P2PNode.getLocalPeerId() }.getOrNull()
        if (peerId.isNullOrEmpty()) {
            // Swarm is running but PeerId not yet available — either a start-up
            // race or the native library predates this feature.
            statusView.text = getString(R.string.error_peer_id_unavailable)
            return ""
        }

        val multiaddr = "/ip4/$ip/tcp/9000/p2p/$peerId"
        return "equilibrium://bootstrap?addr=" + Uri.encode(multiaddr)
    }

    /**
     * Walk [NetworkInterface] and return the best local IPv4 address.
     *
     * Priority (lower is better):
     *   0  192.168.x.x  — home/office WiFi (most reliable for LAN scanning)
     *   1  10.0.2.x     — Android emulator host alias (dev testing)
     *   2  10.x.x.x     — corporate LAN / mobile NAT
     *   3  172.x.x.x    — Docker bridge / cellular
     *   4  anything else non-loopback, non-link-local
     *
     * Returns null if no usable address is found (no WiFi, airplane mode, etc.)
     */
    private fun getLocalIpv4(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces()
            ?.toList()
            ?.flatMap { iface -> iface.inetAddresses?.toList() ?: emptyList() }
            ?.filter { addr ->
                !addr.isLoopbackAddress &&
                !addr.isLinkLocalAddress &&
                addr is Inet4Address
            }
            ?.sortedBy { addr ->
                val h = addr.hostAddress ?: ""
                when {
                    h.startsWith("192.168.") -> 0   // WiFi — best for QR scanning
                    h.startsWith("10.0.2.")  -> 1   // Emulator host alias
                    h.startsWith("10.")      -> 2   // Corporate LAN / hotspot
                    h.startsWith("172.")     -> 3   // Docker / cellular NAT
                    else                     -> 4
                }
            }
            ?.firstOrNull()
            ?.hostAddress
    }.getOrNull()

    /**
     * Render the invite URI as a QR code.
     *
     * Shows an error in [statusView] rather than leaving a blank [qrImage]
     * so the user knows why the QR didn't appear.
     */
    private fun showMyQr() {
        val uri = buildMyInviteUri()
        if (uri.isEmpty()) return  // statusView already updated by buildMyInviteUri()

        runCatching {
            val bitmap: Bitmap = BarcodeEncoder().encodeBitmap(uri, BarcodeFormat.QR_CODE, 512, 512)
            qrImage.setImageBitmap(bitmap)
            statusView.text = getString(R.string.qr_ready_hint)
        }.onFailure { e ->
            qrImage.setImageDrawable(null)
            statusView.text = getString(R.string.error_qr_failed, e.message ?: e.javaClass.simpleName)
        }
    }

    // ── Share ─────────────────────────────────────────────────────────────────

    private fun shareInvite() {
        val uri = buildMyInviteUri()
        if (uri.isEmpty()) return  // statusView already updated

        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, uri)
            putExtra(Intent.EXTRA_SUBJECT, getString(R.string.share_invite_subject))
        }
        startActivity(Intent.createChooser(shareIntent, getString(R.string.share_invite_chooser)))
    }

    // ── QR scanning ───────────────────────────────────────────────────────────

    /**
     * Launch the ZXing embedded scanner via [ScanContract] (ActivityResult API).
     * This replaces the deprecated [IntentIntegrator] + [onActivityResult] pattern.
     */
    private fun launchScanner() {
        barcodeLauncher.launch(
            ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt(getString(R.string.scan_prompt))
                setCameraId(0)
                setBeepEnabled(false)
                setBarcodeImageEnabled(false)
                setOrientationLocked(false)
            }
        )
    }

    // ── Deep-link ─────────────────────────────────────────────────────────────

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.takeIf { it.startsWith("equilibrium://") }?.let { uri ->
            setIntent(intent.putExtra(EXTRA_PREFILL_ADDR, uri))
            addrInput.setText(uri)
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
            val started = P2PNode.startDefaultWithContext(this)
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
