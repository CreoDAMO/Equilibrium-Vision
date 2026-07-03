package com.equilibrium

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.work.*
import java.util.concurrent.TimeUnit

/**
 * MiningService — long-running foreground service that keeps the mining
 * WorkManager job alive and passes configuration to MiningWorker.
 *
 * Configuration (intent extras, optional):
 *   [EXTRA_NODE_URL]      — Equilibrium node base URL
 *                           (default: http://10.0.2.2:8080 — emulator host)
 *   [EXTRA_MINER_ADDRESS] — 40-char hex address for coinbase rewards
 *
 * WorkManager constraints:
 *   - Requires charging
 *   - Requires battery not low
 *   - Requires unmetered network (Wi-Fi / Ethernet)
 *
 * Mining runs every 15 minutes as a PeriodicWorkRequest. Each cycle:
 *   1. Fetches the current chain tip from the node
 *   2. Runs the Rust JNI solver (libequilibrium_core.so)
 *   3. POSTs the solved block to the node's /api/blocks/submit endpoint
 */
class MiningService : Service() {

    companion object {
        const val EXTRA_NODE_URL      = "node_url"
        const val EXTRA_MINER_ADDRESS = "miner_address"

        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID     = "equilibrium_mining"
        private const val WORK_NAME      = "equilibrium_mining_work"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nodeUrl      = intent?.getStringExtra(EXTRA_NODE_URL)
            ?: MiningWorker.DEFAULT_NODE_URL
        val minerAddress = intent?.getStringExtra(EXTRA_MINER_ADDRESS) ?: ""

        // WorkManager constraints: mine only when plugged in and on Wi-Fi
        val constraints = Constraints.Builder()
            .setRequiresCharging(true)
            .setRequiresBatteryNotLow(true)
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build()

        // Pass node URL and miner address as typed input data to MiningWorker
        val inputData = Data.Builder()
            .putString(MiningWorker.KEY_NODE_URL,      nodeUrl)
            .putString(MiningWorker.KEY_MINER_ADDRESS, minerAddress)
            .build()

        val work = PeriodicWorkRequestBuilder<MiningWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setInputData(inputData)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS,
            )
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            work,
        )

        startForeground(NOTIFICATION_ID, buildNotification(nodeUrl))
        return START_STICKY
    }

    private fun buildNotification(nodeUrl: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Equilibrium Mining",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Proof-of-Stationarity background miner"
            }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Equilibrium Mining")
            .setContentText("Connected to $nodeUrl")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
