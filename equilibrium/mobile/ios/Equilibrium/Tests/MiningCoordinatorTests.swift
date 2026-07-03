import XCTest
@testable import EquilibriumMiner

final class MiningCoordinatorTests: XCTestCase {
    func testSingletonIsAccessible() {
        XCTAssertNotNil(MiningCoordinator.shared)
    }

    func testDefaultNodeUrlIsPlaceholder() {
        // Ensure the placeholder URL reminds the developer to configure it
        XCTAssertTrue(MiningCoordinator.shared.nodeBaseUrl.contains("example.com"))
    }
}
