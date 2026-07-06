# Mobile Miner: Android APK Release (Sideload Distribution)

Decision: skip app-store submission for now. We're distributing the Android
mobile miner as a directly-sideloaded APK to trusted contributors first —
this avoids Play Store review/fees, keeps the rollout private, and lets us
fix bugs before any public release. iOS is out of scope for this phase
(TestFlight needs a paid developer account; sideloading requires per-device
signing) — Android only, for now.

## How it fits together

```
equilibrium/                        Rust core (mining solver, JNI bridge)
equilibrium/mobile/android/         Android app (Kotlin + Gradle)
  build-jni.sh                      cross-compiles Rust → .so via cargo-ndk
  app/build.gradle.kts              release signingConfig reads ANDROID_* env vars
scripts/generate-android-keystore.sh   one-time keystore generator (openssl, no JDK needed)
android-apk-ci.yml                  GitHub Actions workflow (repo root — see below)
```

## One-time setup (you do this in GitHub, not Replit)

1. **Copy the CI workflow into place.** This repo can't push directly into
   `.github/workflows/` from Replit, so the workflow lives at the repo root
   as `android-apk-ci.yml`. Copy it to `.github/workflows/android-apk.yml`
   in your GitHub repo.
2. **Generate a signing keystore** (already done once for you — see the chat
   for the values). To regenerate later (e.g. if you rotate keys):
   ```bash
   ./scripts/generate-android-keystore.sh
   ```
   This writes `release-keystore.p12`, `keystore_base64.txt`, and
   `credentials.txt` to `/tmp/equilibrium-keystore/` using `openssl`
   (no JDK/`keytool` required).
3. **Add four GitHub Actions secrets** (Settings → Secrets and variables →
   Actions → New repository secret):
   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | contents of `keystore_base64.txt` |
   | `ANDROID_KEYSTORE_PASSWORD` | store password from `credentials.txt` |
   | `ANDROID_KEY_ALIAS` | alias from `credentials.txt` (`equilibrium-release`) |
   | `ANDROID_KEY_PASSWORD` | key password from `credentials.txt` |
4. **Back up `release-keystore.p12` somewhere private** (password manager,
   vault) outside of git. Losing it means future updates can't be installed
   as upgrades over existing sideloaded copies — Android treats a
   different signing key as a different app.

## Building a release

- **Manually**: GitHub → Actions tab → "Android APK" workflow → Run workflow.
- **On tag push**: push a tag matching `mobile-v*` (e.g. `git tag mobile-v0.1.0 && git push origin mobile-v0.1.0`) to also attach the APK to a GitHub Release automatically.

The workflow:
1. Installs the Rust Android targets + `cargo-ndk`, builds the JNI `.so`
   libraries for `arm64-v8a`, `armeabi-v7a`, `x86_64`.
2. Installs the Android SDK/NDK and `wabt`.
3. Decodes the keystore secret to a temp file, runs
   `./gradlew :app:assembleRelease` with the signing env vars set, then
   deletes the decoded keystore from the runner disk.
4. Uploads `app-release.apk` as a workflow artifact (90-day retention) and,
   on a `mobile-v*` tag, attaches it to a GitHub Release.

## Distributing to contributors

Since this is sideloaded (not Play Store), each contributor needs to:
1. Download `app-release.apk` from the workflow artifact or GitHub Release.
2. Enable "Install unknown apps" for their browser/file manager on Android.
3. Install the APK directly.

Because every release uses the same keystore, contributors can simply
install the new APK over the old one — Android treats it as an update, not
a fresh install (as long as `versionCode` in `app/build.gradle.kts` is
bumped each release).

## Known scope limits (by design, for this phase)

- **No Play Store listing** — no store review, no store fees, no forced
  update mechanism. You control distribution entirely.
- **No iOS build in this CI** — the existing `equilibrium/mobile/ios/`
  Swift package is a separate, still-WIP effort; revisit once the Android
  rollout has validated the mining flow with real contributors.
- **`versionCode`/`versionName`** in `app/build.gradle.kts` must be bumped
  manually before each tagged release — CI does not auto-increment it.
