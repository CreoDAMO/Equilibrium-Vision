# Equilibrium Miner — release ProGuard/R8 rules.

# Keep JNI entry points (Rust core calls into MiningWorker via native methods,
# and JNI resolves them by exact name/signature — must not be renamed).
-keepclasseswithmembernames class com.equilibrium.MiningWorker {
    native <methods>;
}

# org.json is part of the Android platform API, not a library to shrink.
-dontwarn org.json.**

# OkHttp/Okio ship their own consumer ProGuard rules via AAR metadata, but
# keep this as a safety net against R8 warnings on reflectively-used classes.
-dontwarn okhttp3.**
-dontwarn okio.**
