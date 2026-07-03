import Foundation
import BackgroundTasks
import EquilibriumCore

/// Coordinates Proof-of-Stationarity mining on iOS using the BackgroundTasks API.
///
/// Registration (call once in AppDelegate.application(_:didFinishLaunchingWithOptions:)):
///   MiningCoordinator.shared.register()
///
/// Scheduling:
///   MiningCoordinator.shared.scheduleMiningTask()
///
/// The task runs only when:
///   - Device is charging (BGProcessingTaskRequest.requiresExternalPower = true)
///   - Network is available (BGProcessingTaskRequest.requiresNetworkConnectivity = true)
@MainActor
public final class MiningCoordinator {

    public static let shared = MiningCoordinator()

    private static let taskIdentifier = "com.equilibrium.miner.solve"

    /// Node API endpoint — override before calling `register()`.
    public var nodeBaseUrl = "https://your-node.example.com"

    private init() {}

    // ── Registration ──────────────────────────────────────────────────────────

    /// Register the background task identifier.
    /// Must be called before `applicationDidFinishLaunching` returns.
    /// Add "com.equilibrium.miner.solve" to Info.plist under BGTaskSchedulerPermittedIdentifiers.
    public func register() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.taskIdentifier,
            using: nil
        ) { task in
            guard let task = task as? BGProcessingTask else { return }
            Task { @MainActor in
                await self.handleMiningTask(task)
            }
        }
    }

    // ── Scheduling ────────────────────────────────────────────────────────────

    /// Schedule the next mining window.
    /// Call this after each successful or failed task run to keep the chain going.
    public func scheduleMiningTask() {
        let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
        request.requiresExternalPower      = true   // Only run while charging
        request.requiresNetworkConnectivity = true  // Need network to submit blocks
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // At most every 15 min

        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[EquilibriumMiner] Failed to schedule mining task: \(error)")
        }
    }

    // ── Task handler ──────────────────────────────────────────────────────────

    private func handleMiningTask(_ task: BGProcessingTask) async {
        // Reschedule immediately so we always have a next run queued
        scheduleMiningTask()

        let miningTask = Task {
            await runOneMiningCycle()
        }

        task.expirationHandler = {
            miningTask.cancel()
        }

        _ = await miningTask.result
        task.setTaskCompleted(success: !miningTask.isCancelled)
    }

    // ── Mining cycle ──────────────────────────────────────────────────────────

    private func runOneMiningCycle() async {
        do {
            // 1. Fetch current chain tip from the node
            let status = try await fetchChainStatus()

            // 2. Run the Rust StationarySolver via EquilibriumCore FFI
            let residual = EquilibriumCoreStub.solve(
                prevHash: status.latestHash,
                difficulty: 1e-7
            )

            // 3. Submit the solved block to the node
            try await submitBlock(prevHash: status.latestHash, residual: residual, height: status.height + 1)

            print("[EquilibriumMiner] Block submitted at height \(status.height + 1), residual=\(residual)")
        } catch {
            print("[EquilibriumMiner] Mining cycle failed: \(error)")
        }
    }

    // ── Node API calls ────────────────────────────────────────────────────────

    private struct ChainStatus: Decodable {
        let height: Int
        let latestHash: String
    }

    private func fetchChainStatus() async throws -> ChainStatus {
        let url = URL(string: "\(nodeBaseUrl)/api/chain/status")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(ChainStatus.self, from: data)
    }

    private func submitBlock(prevHash: String, residual: Double, height: Int) async throws {
        var request = URLRequest(url: URL(string: "\(nodeBaseUrl)/api/blocks")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "prevHash": prevHash,
            "residual": residual,
            "height": height,
            "miner": "ios-miner",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
    }
}
