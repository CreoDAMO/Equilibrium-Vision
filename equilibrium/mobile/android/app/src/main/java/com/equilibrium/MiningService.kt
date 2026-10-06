package com.equilibrium

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.WorkManager

/**
 * Foreground solver loop. WorkManager's old 15-minute charging job is not
 * this loop, and it is cancelled on start so it cannot be the thing that
 * "mines" only while plugged into Wi-Fi.
 *
 * No miner address, no start. The address is the user's. It is not invented.
 */
class MiningService : Service() {

    companion object {
        const val EXTRA_NODE_URL = "node_url"
        const val EXTRA_MINER_ADDRESS = "miner_address"
        const val ACTION_STOP = "com.equilibrium.STOP_MINING"

        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "equilibrium_mining"
        private const val PREFS = "equ_prefs"
        private const val KEY_NODE = "node_url"
        private const val KEY_MINER = "miner_address"
        private const val OLD_PERIODIC_WORK = "equilibrium_mining_work"

        fun start(context: Context, nodeUrl: String, minerAddress: String) {
            val intent = Intent(context, MiningService::class.java)
                .putExtra(EXTRA_NODE_URL, nodeUrl)
                .putExtra(EXTRA_MINER_ADDRESS, minerAddress)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, MiningService::class.java).setAction(ACTION_STOP),
            )
        }
    }

    @Volatile private var running = false
    private var thread: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            runCatching { startInForeground("stopped") }
            halt()
            return START_NOT_STICKY
        }

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val nodeUrl = intent?.getStringExtra(EXTRA_NODE_URL)
            ?: prefs.getString(KEY_NODE, null)
            ?: MiningWorker.DEFAULT_NODE_URL
        val minerAddress = MiningWorker.normalizeMinerAddress(
            intent?.getStringExtra(EXTRA_MINER_ADDRESS) ?: prefs.getString(KEY_MINER, null),
        )
        if (minerAddress == null) {
            startInForeground(nodeUrl)
            halt()
            MiningState.mining = "stopped"
            MiningState.solver = "miner address required"
            MiningState.note = "A 40-character hex reward address is required. None was assigned."
            return START_NOT_STICKY
        }
        prefs.edit().putString(KEY_NODE, nodeUrl).putString(KEY_MINER, minerAddress).apply()

        WorkManager.getInstance(this).cancelUniqueWork(OLD_PERIODIC_WORK)
        startInForeground(nodeUrl)
        if (running) return START_STICKY

        running = true
        MiningState.mining = "active"
        MiningState.solver = "running"
        thread = Thread({
            val cycle = MiningCycle(applicationContext) { prev, merkle, timestamp, difficulty, depth, pressure, work, attempts, nonce, residual ->
                CoreSolver.solveBlock(prev, merkle, timestamp, difficulty, depth, pressure, work, attempts, nonce, residual)
            }
            while (running) {
                try {
                    cycle.run(nodeUrl, minerAddress)
                } catch (t: Throwable) {
                    MiningState.solver = "error"
                    MiningState.note = t.message ?: "cycle failed"
                }
                if (running) updateNotification(nodeUrl)
                var waited = 0
                while (running && waited < 20) {
                    try {
                        Thread.sleep(100)
                    } catch (_: InterruptedException) {
                        break
                    }
                    waited++
                }
            }
            MiningState.mining = "stopped"
            if (MiningState.solver == "running") MiningState.solver = "idle"
        }, "eq-solver")
        thread?.start()
        return START_STICKY
    }

    private fun halt() {
        running = false
        MiningState.mining = "stopped"
        MiningState.solver = "idle"
        thread?.interrupt()
        thread = null
        WorkManager.getInstance(this).cancelUniqueWork(OLD_PERIODIC_WORK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun startInForeground(nodeUrl: String) {
        val notification = buildNotification(nodeUrl)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(nodeUrl: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification(nodeUrl))
    }

    private fun buildNotification(nodeUrl: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Equilibrium Mining",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Proof-of-Stationarity miner"
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val text = "${MiningState.solver} · height ${MiningState.httpHeight}"
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Equilibrium mining")
            .setContentText(text.ifBlank { nodeUrl })
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running = false
        thread?.interrupt()
        if (MiningState.mining == "active") MiningState.mining = "stopped"
        super.onDestroy()
    }
}
