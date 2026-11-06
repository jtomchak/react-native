import XCTest

final class NativeHealthTests: XCTestCase {
  func testAsyncHostFailureRemainsVisibleInHealth() {
    let app = XCUIApplication(bundleIdentifier: "dev.nativehost.prototype")
    app.launchArguments = ["--native-host-inject-error"]
    app.launch()
    let surface = app.descendants(matching: .any).matching(identifier: "native-surface").firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 20))
    let fault = NSPredicate { _, _ in
      guard let value = surface.value as? String,
            let data = value.data(using: .utf8),
            let health = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
      return health["healthy"] as? Bool == false && (health["status"] as? String ?? "").contains("intentional-ios-health-fault")
    }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: fault, object: nil)], timeout: 10), .completed)
    app.buttons["increment"].tap()
    XCTAssertTrue(fault.evaluate(with: nil), "A later successful action must not erase the sticky runtime failure")
  }
}
