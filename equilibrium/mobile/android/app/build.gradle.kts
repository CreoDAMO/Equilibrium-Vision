plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.equilibrium"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.equilibrium.miner"
        minSdk = 26          // Android 8 — required for WorkManager foreground service
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // JNI libraries built by cargo-ndk go here:
    //   cargo ndk -t armeabi-v7a -t arm64-v8a -t x86_64 -o app/src/main/jniLibs build --release
    sourceSets["main"].jniLibs.srcDirs("src/main/jniLibs")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)

    // WorkManager for battery-aware background mining
    implementation(libs.androidx.work.runtime.ktx)

    // HTTP client for submitting solved blocks to the node API
    implementation(libs.okhttp)
}

// ── cargo-ndk integration ─────────────────────────────────────────────────────
//
// Cross-compiles the Equilibrium Rust core for Android and drops the resulting
// .so files into src/main/jniLibs/ where the Android build system picks them up.
//
// Run manually:   ../build-jni.sh
// Gradle task:    ./gradlew cargoNdkBuild
//
// Prerequisites (see ../build-jni.sh for the full guide):
//   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
//   cargo install cargo-ndk
//   export ANDROID_NDK_HOME=/path/to/ndk
//
// To make every Gradle build trigger cargo-ndk automatically, uncomment the
// dependsOn line in the preBuild block below.

val cargoNdkBuild by tasks.registering(Exec::class) {
    description = "Cross-compile Rust core for Android via cargo-ndk"
    group = "build"
    workingDir = file("..") // equilibrium/mobile/android/
    commandLine("bash", "build-jni.sh")
    inputs.dir("${rootDir}/../../src")
    outputs.dir("src/main/jniLibs")
}

tasks.named("preBuild") {
    // Uncomment to wire cargo-ndk into every Gradle build automatically:
    // dependsOn(cargoNdkBuild)
}
