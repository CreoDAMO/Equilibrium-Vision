package com.equilibrium.workers

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log

/**
 * ThermalGuard — queries the Android Thermal API to decide whether it is
 * safe to run CPU/NPU-intensive workloads (mining, NTK training).
 *
 * On Android Q (API 29) and above, [PowerManager.getCurrentThermalStatus]
 * returns one of five severity levels. We allow mining only at NONE and LIGHT;
 * MODERATE and above risk sustained throttling or OEM-triggered shutdown.
 *
 * On older devices (API < 29), the API is unavailable — we conservatively
 * allow the workload and let the OS throttle as needed.
 */
object ThermalGuard {
    private const val TAG = "ThermalGuard"

    /**
     * Returns true if the device thermal state is safe enough to run
     * compute-intensive work. Call this before starting a mining cycle.
     */
    fun isThermalSafe(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // API unavailable — allow, rely on OS scheduler throttling.
            return true
        }

        val pm     = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val status = pm.currentThermalStatus

        val safe = status == PowerManager.THERMAL_STATUS_NONE ||
                   status == PowerManager.THERMAL_STATUS_LIGHT

        if (!safe) {
            Log.w(TAG, "Thermal throttling active (status=$status) — skipping compute cycle")
        } else {
            Log.d(TAG, "Thermal status OK (status=$status)")
        }
        return safe
    }

    /**
     * Human-readable label for a thermal status code (useful in logs).
     */
    fun statusLabel(status: Int): String = when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> "unavailable"
        status == PowerManager.THERMAL_STATUS_NONE      -> "none"
        status == PowerManager.THERMAL_STATUS_LIGHT     -> "light"
        status == PowerManager.THERMAL_STATUS_MODERATE  -> "moderate"
        status == PowerManager.THERMAL_STATUS_SEVERE    -> "severe"
        status == PowerManager.THERMAL_STATUS_CRITICAL  -> "critical"
        status == PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        status == PowerManager.THERMAL_STATUS_SHUTDOWN  -> "shutdown"
        else                                            -> "unknown($status)"
    }

    /**
     * Returns the current thermal status code, or -1 if the API is unavailable.
     */
    fun currentStatus(context: Context): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return -1
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.currentThermalStatus
    }
}
