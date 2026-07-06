package com.equilibrium

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

/**
 * MainActivity — landing screen for the sideloaded miner app.
 *
 * Since there's no Play Store to auto-update a sideloaded APK, this screen
 * exposes an explicit "Check for Updates" action that polls the node API's
 * `/api/mobile/version` endpoint (see UpdateChecker.kt) and, if a newer
 * signed build has been published, offers to open it in the browser for
 * download + manual install.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var updateChecker: UpdateChecker
    private lateinit var updateStatus: TextView
    private lateinit var updateProgress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val nodeUrl = MiningWorker.DEFAULT_NODE_URL
        updateChecker = UpdateChecker(nodeUrl)

        val versionLabel = findViewById<TextView>(R.id.versionLabel)
        versionLabel.text = getString(
            R.string.current_version,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
        )

        updateStatus = findViewById(R.id.updateStatus)
        updateProgress = findViewById(R.id.updateProgress)

        findViewById<MaterialButton>(R.id.checkUpdatesButton).setOnClickListener {
            checkForUpdates()
        }

        // Check automatically on launch too, so contributors notice new
        // builds without having to remember to tap the button.
        checkForUpdates()
    }

    private fun checkForUpdates() {
        updateProgress.visibility = View.VISIBLE
        updateStatus.text = getString(R.string.checking_updates)

        updateChecker.checkForUpdate(BuildConfig.VERSION_CODE) { result ->
            runOnUiThread {
                updateProgress.visibility = View.GONE
                when (result) {
                    is UpdateCheckResult.UpToDate -> {
                        updateStatus.text = getString(R.string.up_to_date, result.currentVersionName)
                    }
                    is UpdateCheckResult.UpdateAvailable -> {
                        updateStatus.text = ""
                        showUpdateDialog(result)
                    }
                    is UpdateCheckResult.Error -> {
                        updateStatus.text = getString(R.string.update_check_failed, result.message)
                    }
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
