/// Stub module — replace this target with the real xcframework built by cargo-swift.
///
/// Build the real framework:
///   cd equilibrium
///   cargo swift package --platforms ios --name EquilibriumCore
///   cp -r EquilibriumCore ../mobile/ios/
///
/// Then update Package.swift to use a `.binaryTarget` pointing at the xcframework.
public enum EquilibriumCoreStub {
    /// Placeholder solve function — returns a fake residual.
    public static func solve(prevHash: String, difficulty: Double) -> Double {
        return 1e-9
    }
}
