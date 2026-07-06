package com.equilibrium

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * UpdateChecker — polls the node API's `/api/mobile/version` endpoint so
 * sideloaded builds (no Play Store) can tell the user a newer signed APK is
 * available. See android-apk-ci.yml, which publishes this metadata after
 * every `mobile-v*` tagged build.
 */
sealed class UpdateCheckResult {
    data class UpToDate(val currentVersionName: String) : UpdateCheckResult()
    data class UpdateAvailable(
        val versionCode: Int,
        val versionName: String,
        val downloadUrl: String,
        val releaseNotes: String?,
    ) : UpdateCheckResult()
    data class Error(val message: String) : UpdateCheckResult()
}

class UpdateChecker(private val nodeUrl: String) {

    companion object {
        private val http = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    /**
     * Fetches the latest published Android release and compares it against
     * [currentVersionCode]. Invokes [callback] on a background thread — the
     * caller is responsible for hopping back to the main thread before
     * touching UI.
     */
    fun checkForUpdate(currentVersionCode: Int, callback: (UpdateCheckResult) -> Unit) {
        val request = Request.Builder()
            .url("$nodeUrl/api/mobile/version?platform=android")
            .get()
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(UpdateCheckResult.Error(e.message ?: "network error"))
            }

            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.use {
                    if (response.code == 404) {
                        callback(UpdateCheckResult.Error("No release has been published yet"))
                        return
                    }
                    if (!response.isSuccessful) {
                        callback(UpdateCheckResult.Error("HTTP ${response.code}"))
                        return
                    }
                    try {
                        val body = response.body?.string() ?: ""
                        val json = JSONObject(body)
                        val latestVersionCode = json.getInt("versionCode")
                        val latestVersionName = json.getString("versionName")

                        if (latestVersionCode > currentVersionCode) {
                            callback(
                                UpdateCheckResult.UpdateAvailable(
                                    versionCode = latestVersionCode,
                                    versionName = latestVersionName,
                                    downloadUrl = json.getString("downloadUrl"),
                                    releaseNotes = json.optString("releaseNotes", "").ifBlank { null },
                                )
                            )
                        } else {
                            callback(UpdateCheckResult.UpToDate(latestVersionName))
                        }
                    } catch (e: Exception) {
                        callback(UpdateCheckResult.Error("Malformed response: ${e.message}"))
                    }
                }
            }
        })
    }
}
