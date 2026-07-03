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
