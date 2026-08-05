package com.equilibrium

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * UpdateChecker — queries the GitHub Releases API for the latest `mobile-v*`
 * tag and compares it against the installed build so sideloaded installs
 * (no Play Store auto-update) can tell the user a newer signed APK is available.
 *
 * Why GitHub Releases instead of the node API?
 *   The node API's `/api/mobile/version` endpoint is useful for server-side
 *   telemetry, but it requires the mining node to be reachable — which on a
 *   real phone means either a locally running server or an internet-accessible
 *   deployment. The GitHub Releases API is always reachable over HTTPS, needs
 *   no authentication for public repos, and is the canonical source of the
 *   signed APK download URL anyway.
 *
 * Release tag convention: `mobile-v<versionName>` (e.g. `mobile-v0.1.0`).
 * The APK asset must be named `app-release.apk` (matches the Gradle output name
 * that android-apk.yml uploads to the release).
 */
sealed class UpdateCheckResult {
    data class UpToDate(val currentVersionName: String) : UpdateCheckResult()
    data class UpdateAvailable(
        val versionCode: Int,       // 0 when sourced from GitHub (not used for comparison)
        val versionName: String,
        val downloadUrl: String,
        val releaseNotes: String?,
    ) : UpdateCheckResult()
    data class Error(val message: String) : UpdateCheckResult()
}

class UpdateChecker {

    companion object {
        private val http = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .addInterceptor { chain ->
                // GitHub API requires a User-Agent; omitting it returns 403.
                val req = chain.request().newBuilder()
                    .header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "EquilibriumMiner/${BuildConfig.VERSION_NAME}")
                    .build()
                chain.proceed(req)
            }
            .build()

        private const val API_URL =
            "https://api.github.com/repos/${BuildConfig.GITHUB_REPO}/releases/latest"

        /**
         * Semver comparison: returns true if [latest] is strictly newer than [current].
         * Both strings should be in `MAJOR.MINOR.PATCH` form; extra segments are
         * compared lexicographically as integers with missing segments treated as 0.
         */
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
            return false // equal
        }
    }

    /**
     * Fetches the latest published GitHub Release and compares its tag against
     * [currentVersionName]. Invokes [callback] on a background thread — the
     * caller is responsible for hopping back to the main thread before touching UI.
     *
     * Tag convention: `mobile-v0.1.0` → versionName `0.1.0`
     */
    fun checkForUpdate(
        currentVersionCode: Int,    // kept for API compatibility; comparison uses versionName
        currentVersionName: String = BuildConfig.VERSION_NAME,
        callback: (UpdateCheckResult) -> Unit,
    ) {
        val request = Request.Builder().url(API_URL).get().build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(UpdateCheckResult.Error(e.message ?: "network error"))
            }

            override fun onResponse(call: Call, response: okhttp3.Response) {
                response.use {
                    when {
                        response.code == 404 ->
                            // No release tagged yet — not an error, just nothing published.
                            callback(UpdateCheckResult.UpToDate(currentVersionName))

                        !response.isSuccessful ->
                            callback(UpdateCheckResult.Error("GitHub API returned HTTP ${response.code}"))

                        else -> parseResponse(response, currentVersionName, callback)
                    }
                }
            }
        })
    }

    private fun parseResponse(
        response: okhttp3.Response,
        currentVersionName: String,
        callback: (UpdateCheckResult) -> Unit,
    ) {
        try {
            val body = response.body?.string() ?: ""
            val json = JSONObject(body)

            // tag_name: "mobile-v0.1.0" → strip prefix → "0.1.0"
            val tagName = json.getString("tag_name")
            val latestVersionName = tagName
                .removePrefix("mobile-v")
                .removePrefix("v")
                .trim()

            // Find the APK asset download URL.
            val assets = json.optJSONArray("assets")
            val apkUrl = (0 until (assets?.length() ?: 0))
                .mapNotNull { i ->
                    val asset = assets?.getJSONObject(i)
                    if (asset?.getString("name")?.endsWith(".apk") == true)
                        asset.getString("browser_download_url")
                    else null
                }
                .firstOrNull()

            val releaseNotes = json.optString("body", "").ifBlank { null }

            if (isNewerVersion(latestVersionName, currentVersionName)) {
                callback(
                    UpdateCheckResult.UpdateAvailable(
                        versionCode  = 0,   // not available from GitHub API; unused
                        versionName  = latestVersionName,
                        downloadUrl  = apkUrl ?: "https://github.com/${BuildConfig.GITHUB_REPO}/releases/latest",
                        releaseNotes = releaseNotes,
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
