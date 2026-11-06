import XCTest

final class AppStateTests: XCTestCase {
  func testRealApplicationLifecycleAndUnsubscribe() throws {
    let revision = ProcessInfo.processInfo.environment["NH_DRIVER_REVISION"] ?? ""
    guard !revision.isEmpty else { throw XCTSkip("Explicit immutable AppState fixture revision required") }
    let app = XCUIApplication()
    if !revision.hasPrefix("packaged:") { app.launchArguments = ["--native-host-revision", revision] }
    app.launch()
    func element(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    func text(_ id: String) -> String { element(id).label }
    func until(_ reason: String, _ condition: @escaping () -> Bool) {
      let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
      XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 15), .completed, reason)
    }
    func record(_ id: String) throws -> Any {
      try JSONSerialization.jsonObject(with: Data(text(id).utf8))
    }
    func capture() throws -> [String: Any] {
      let previous = (try record("as-snapshot") as? [String: Any])?["snapshotSerial"] as? Int ?? 0
      element("as-snapshot-button").tap()
      until("new native-captured snapshot") {
        ((try? record("as-snapshot") as? [String: Any])?["snapshotSerial"] as? Int ?? 0) > previous
      }
      let value = try XCTUnwrap(record("as-snapshot") as? [String: Any])
      XCTAssertEqual(value["state"] as? String, "active")
      XCTAssertEqual(value["source"] as? String, "native-lifecycle")
      return value
    }
    func health() throws -> [String: Any] {
      let raw = try XCTUnwrap(element("native-surface").value as? String)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    func cycle() {
      XCUIDevice.shared.press(.home)
      until("actual OS background") { app.state == .runningBackground || app.state == .runningBackgroundSuspended }
      XCTAssertNotEqual(app.state, .notRunning, "foreground must not substitute a new process")
      app.activate()
      XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
      // RunningForeground precedes the end of the system activation transition.
      // Require an actionable target with stable geometry across observations;
      // a tap immediately after activate can be consumed by that transition.
      var previous = CGRect.null
      until("foreground action target stable and hittable") {
        let target = element("as-snapshot-button"), frame = target.frame
        let ready = target.isHittable && !frame.isEmpty && frame == previous
        previous = frame
        return ready
      }
    }
    XCTAssertTrue(element("as-current").waitForExistence(timeout: 15))
    until("active OS state") { text("as-current") == "active" }
    XCTAssertEqual(text("as-capability"), "true")
    XCTAssertEqual(text("as-error"), "none")
    let identity = try health(), instance = text("as-instance")
    let initial = try capture()
    let before = try XCTUnwrap(record("as-events") as? [[String: Any]])
    cycle()
    until("background and active lifecycle delivery") {
      guard let events = try? record("as-events") as? [[String: Any]] else { return false }
      let added = events.dropFirst(before.count)
      return added.contains { $0["state"] as? String == "background" } && added.last?["state"] as? String == "active"
    }
    let events = try XCTUnwrap(record("as-events") as? [[String: Any]])
    let added = Array(events.dropFirst(before.count))
    for (previous, next) in zip(added, added.dropFirst()) {
      XCTAssertGreaterThan(next["sequence"] as? Int ?? -1, previous["sequence"] as? Int ?? -1)
    }
    XCTAssertTrue(added.allSatisfy { ($0["generation"] as? Int) == (initial["generation"] as? Int) })
    let after = try health()
    XCTAssertEqual(after["pid"] as? Int, identity["pid"] as? Int)
    XCTAssertEqual(after["runtimeEpoch"] as? String, identity["runtimeEpoch"] as? String)
    XCTAssertEqual(text("as-instance"), instance)
    let active = try capture()
    element("as-unsubscribe").tap()
    until("unsubscribe") { text("as-subscribed") == "false" }
    let stopped = text("as-events")
    cycle()
    let fresh = try capture()
    XCTAssertGreaterThan(fresh["sequence"] as? Int ?? -1, active["sequence"] as? Int ?? -1)
    XCTAssertEqual(text("as-events"), stopped)
    XCTAssertEqual(text("as-instance"), instance)
    XCTAssertEqual(text("as-error"), "none")
    let evidence: [String: Any] = ["kind": "actual-UIApplication-Home-activate", "revision": revision,
      "identity": identity, "after": after, "initial": initial, "events": events, "active": active,
      "unsubscribedSnapshot": fresh, "sameInstance": instance]
    let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
    attachment.name = "AppState-physical-evidence"; attachment.lifetime = .keepAlways; add(attachment)
  }
}
