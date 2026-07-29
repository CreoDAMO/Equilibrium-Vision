fn main() {
    // RISC0_BUILD_SKIP_BUILD is the official risc0 mechanism to disable guest
    // compilation (used in CI without the risc0 toolchain, `cargo check`, etc.).
    // When set, we write stub constants so the crate still compiles cleanly.
    if std::env::var("RISC0_BUILD_SKIP_BUILD").is_ok() {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
        std::fs::write(
            format!("{out_dir}/methods.rs"),
            r#"
/// Placeholder ELF — build with the risc0 toolchain to produce a real value.
/// Set RISC0_BUILD_SKIP_BUILD=1 (this mode) only for `cargo check` / CI lint passes.
pub const STATIONARITY_GUEST_ELF: &[u8] = &[];
/// Placeholder image ID — build with the risc0 toolchain to produce a real value.
pub const STATIONARITY_GUEST_ID: [u32; 8] = [0u32; 8];
"#,
        )
        .expect("failed to write stub methods.rs");
        return;
    }

    risc0_build::embed_methods();
}
