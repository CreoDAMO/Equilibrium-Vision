package com.equilibrium

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The public site is the only update source. GitHub is not asked.
 * A release counts only when the manifest says it is published and names a file.
 */
sealed class UpdateCheckResult {
    data class UpToDate(val currentVersionName: String) : UpdateCheckResult()
    data class Unpublished(val currentVersionName: String) : UpdateCheckResult()
    data class UpdateAvailable(
        val versionCode: Int,
        val versionName: String,
        val downloadUrl: String,
        val releaseNotes: String?,
        val sha256: String?,
    ) : UpdateCheckResult()
    data class Error(val message: String) : UpdateCheckResult()
}

class UpdateChecker {

    companion object {
        private val http = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build()

        fun isNewerVersion(latest: String, current: String): Boolean {
            val lp = latest.split(".").map { it.trim().toIntOrNull() ?: 0 }
            val cp = current.split(".").map { it.trim().toIntOrNull() ?: 0 }
            val len = maxOf(lp.size, cp.size)
            for (i in 0 until len) {
                val l = lp.getOrElse(i) { 0 }
                val c = cp.getOrElse(i) { 0 }
                if (l > c) return true
                if (l < c) return false
            }
            return false
        }
    }

    fun checkForUpdate(
        origin: String,
        currentVersionCode: Int,
        currentVersionName: String = BuildConfig.VERSION_NAME,
        callback: (UpdateCheckResult) -> Unit,
    ) {
        val request = Request.Builder().url(MinerNetwork.releaseUrl(origin)).get().build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(UpdateCheckResult.Error(e.message ?: "network error"))
            }

            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.use {
                    if (!response.isSuccessful) {
                        callback(UpdateCheckResult.Error("release manifest returned HTTP ${response.code}"))
                        return
                    }
                    parseResponse(response, currentVersionCode, currentVersionName, callback)
                }
            }
        })
    }

    private fun parseResponse(
        response: okhttp3.Response,
        currentVersionCode: Int,
        currentVersionName: String,
        callback: (UpdateCheckResult) -> Unit,
    ) {
        try {
            val json = JSONObject(response.body?.string() ?: "")
            val published = json.optBoolean("published", false)
            val apkUrl = json.optString("apkUrl", "")
            val versionName = json.optString("version", "").removePrefix("v").trim()
            val versionCode = json.optInt("versionCode", 0)
            val notes = json.optString("notes", "").ifBlank { null }
            val sha = json.optString("sha256", "").ifBlank { null }
            if (!published || apkUrl.isBlank() || versionName.isBlank()) {
                callback(UpdateCheckResult.Unpublished(currentVersionName))
                return
            }
            val newer = if (versionCode > 0 && currentVersionCode > 0) {
                versionCode > currentVersionCode
            } else {
                isNewerVersion(versionName, currentVersionName)
            }
            if (newer) {
                callback(
                    UpdateCheckResult.UpdateAvailable(
                        versionCode = versionCode,
                        versionName = versionName,
                        downloadUrl = apkUrl,
                        releaseNotes = notes,
                        sha256 = sha,
                    )
                )
            } else {
                callback(UpdateCheckResult.UpToDate(versionName))
            }
        } catch (e: Exception) {
            callback(UpdateCheckResult.Error("Malformed release manifest: ${e.message}"))
        }
    }
}
