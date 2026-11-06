import XCTest
import Darwin

// This server exists only inside the XCTest runner, never the app binary.
final class NativeDriverTests: XCTestCase {
  struct DriverError: Error {
    let code: String
    let message: String
  }

  func testDriverSession() throws {
    continueAfterFailure = false
    let environment = ProcessInfo.processInfo.environment
    guard environment["NH_DRIVER_ENABLED"] == "1" else {
      throw XCTSkip("Driver is started explicitly by driver.sh")
    }
    let token = environment["NH_DRIVER_TOKEN"] ?? ""
    guard token.count >= 24, !token.contains("${") else {
      throw DriverError(code: "CONFIGURATION", message: "A driver token of at least 24 characters is required")
    }
    let port = UInt16(environment["NH_DRIVER_PORT"] ?? "19842") ?? 19842
    let lifetime = min(600, max(30, Double(environment["NH_DRIVER_TIMEOUT"] ?? "180") ?? 180))
    let listener = socket(AF_INET, SOCK_STREAM, 0)
    guard listener >= 0 else { throw DriverError(code: "SOCKET", message: "Cannot create listener") }
    defer { Darwin.close(listener) }
    var reuse: Int32 = 1
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse)))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, listen(listener, 2) == 0 else {
      throw DriverError(code: "BIND", message: "Cannot bind loopback driver port \(port)")
    }
    let app = XCUIApplication(bundleIdentifier: "dev.nativehost.prototype")
    if let revision = environment["NH_DRIVER_REVISION"], !revision.isEmpty {
      app.launchArguments += ["--native-host-revision", revision]
    }
    if environment["NH_DRIVER_INJECT_FAULT"] == "1" { app.launchArguments += ["--native-host-inject-error"] }
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "native-surface").firstMatch.waitForExistence(timeout: 20))
    print("NATIVE_HOST_DRIVER_READY 127.0.0.1:\(port)")
    let deadline = Date().addingTimeInterval(lifetime)
    var closed = false
    while !closed && Date() < deadline {
      var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
      if poll(&descriptor, 1, 1000) <= 0 { continue }
      let client = accept(listener, nil, nil)
      if client < 0 { continue }
      defer { Darwin.close(client) }
      var noSignal: Int32 = 1
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal)))
      var sendTimeout = timeval(tv_sec: 5, tv_usec: 0)
      setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout.size(ofValue: sendTimeout)))
      var authenticated = false
      var pending = Data()
      var disconnect = false
      while !closed && !disconnect && Date() < deadline {
        var readable = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
        if poll(&readable, 1, 1000) <= 0 { continue }
        var bytes = [UInt8](repeating: 0, count: 8192)
        let count = recv(client, &bytes, bytes.count, 0)
        if count <= 0 { break }
        pending.append(contentsOf: bytes.prefix(count))
        if pending.count > 1_048_576 { break }
        while let newline = pending.firstIndex(of: 10) {
          let line = pending.subdata(in: pending.startIndex..<newline)
          pending.removeSubrange(pending.startIndex...newline)
          var requestID: Any = NSNull()
          var response: [String: Any]
          do {
            guard let request = try JSONSerialization.jsonObject(with: line) as? [String: Any], let method = request["method"] as? String else {
              throw DriverError(code: "INVALID_REQUEST", message: "Expected JSON {id,method,params}")
            }
            requestID = request["id"] ?? NSNull()
            let params = request["params"] as? [String: Any] ?? [:]
            if !authenticated {
              guard method == "session.authenticate", params["token"] as? String == token else {
                disconnect = true
                throw DriverError(code: "UNAUTHORIZED", message: "Authenticate before using the driver")
              }
              authenticated = true
              response = ["id": requestID, "result": ["authenticated": true]]
            } else if method == "session.close" {
              closed = true
              response = ["id": requestID, "result": ["closed": true]]
            } else {
              response = ["id": requestID, "result": try command(method, params, app)]
            }
          } catch let error as DriverError {
            response = ["id": requestID, "error": ["code": error.code, "message": error.message]]
          } catch {
            response = ["id": requestID, "error": ["code": "DRIVER_ERROR", "message": String(describing: error)]]
          }
          var output = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
          output.append(10)
          let sent = output.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
              let n = send(client, raw.baseAddress!.advanced(by: offset), raw.count - offset, 0)
              if n <= 0 { return false }
              offset += n
            }
            return true
          }
          if !sent { disconnect = true }
          if closed || disconnect { break }
        }
      }
    }
    XCTAssertTrue(closed, "Driver expired without session.close")
  }

  private func element(_ params: [String: Any], _ app: XCUIApplication) throws -> XCUIElement {
    guard let testID = params["testID"] as? String, !testID.isEmpty else {
      throw DriverError(code: "INVALID_ARGUMENT", message: "testID is required")
    }
    let candidate = app.descendants(matching: .any).matching(identifier: testID).firstMatch
    guard candidate.waitForExistence(timeout: 3) else {
      throw DriverError(code: "NOT_FOUND", message: "No accessible element for \(testID)")
    }
    return candidate
  }

  private func describe(_ element: XCUIElement) -> [String: Any] {
    let frame = element.frame
    return ["testID": element.identifier, "type": element.elementType.rawValue,
            "label": element.label, "value": String(describing: element.value ?? ""),
            "exists": element.exists, "enabled": element.isEnabled, "visible": !frame.isEmpty, "hittable": element.isHittable,
            "bounds": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]]
  }

  private func coordinate(_ app: XCUIApplication, x: CGFloat, y: CGFloat) -> XCUICoordinate {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
  }

  private func snapshotNodes(_ root: XCUIElementSnapshot) -> [[String: Any]] {
    var nodes: [[String: Any]] = []
    func visit(_ node: XCUIElementSnapshot) {
      guard nodes.count < 2048 else { return }
      if !node.identifier.isEmpty {
        let frame = node.frame
        nodes.append(["testID": node.identifier, "type": node.elementType.rawValue,
                      "label": node.label, "value": String(describing: node.value ?? ""),
                      "enabled": node.isEnabled, "visible": !frame.isEmpty && frame.intersects(root.frame),
                      "bounds": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]])
      }
      for child in node.children { visit(child) }
    }
    visit(root)
    return nodes
  }

  private func command(_ method: String, _ params: [String: Any], _ app: XCUIApplication) throws -> Any {
    switch method {
    case "session.describe":
      var identity: [String: Any] = ["backend": "ios-xctest", "platform": "ios", "mechanism": "system-coordinate",
              "transport": "loopback-ndjson", "capabilities": ["session.health", "ui.find", "ui.tap", "ui.type", "ui.text", "ui.snapshot", "ui.dismissKeyboard", "webview.tap", "lifecycle.background", "lifecycle.activate"],
              "unsupported": ["webview.evaluate", "runtime.eval", "native.snapshot"], "testOnly": true]
      for (key, value) in nativeHealth(app) { identity[key] = value }
      return identity
    case "lifecycle.background":
      XCUIDevice.shared.press(.home)
      let background = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
        app.state == .runningBackground || app.state == .runningBackgroundSuspended
      }, object: nil)
      guard XCTWaiter.wait(for: [background], timeout: 10) == .completed else {
        throw DriverError(code: "LIFECYCLE_TIMEOUT", message: "Application did not enter background")
      }
      return ["performed": true, "mechanism": "system-home-button"]
    case "lifecycle.activate":
      guard app.state != .notRunning else { throw DriverError(code: "PROCESS_EXITED", message: "Cannot substitute relaunch for foreground transition") }
      app.activate()
      guard app.wait(for: .runningForeground, timeout: 10) else { throw DriverError(code: "LIFECYCLE_TIMEOUT", message: "Application did not enter foreground") }
      return ["performed": true, "mechanism": "os-activate-existing-process"]
    case "ui.find": return describe(try element(params, app))
    case "session.health":
      return nativeHealth(app)
    case "ui.text":
      let target = try element(params, app)
      let value = target.value as? String ?? ""
      let editable = [.textField, .secureTextField, .textView].contains(target.elementType)
      return ["text": editable ? value : (value.isEmpty ? target.label : value), "label": target.label, "value": value]
    case "ui.snapshot":
      // A single immutable snapshot prevents WebKit tree changes from invalidating
      // index-based XCUI queries halfway through serialization.
      let nodes = snapshotNodes(try app.snapshot())
      return ["backend": "ios-xctest", "source": "native-accessibility", "nodes": nodes]
    case "ui.tap":
      let target = try element(params, app)
      guard target.isHittable else { throw DriverError(code: "NOT_HITTABLE", message: "Element is not hittable") }
      let frame = target.frame
      coordinate(app, x: frame.midX, y: frame.midY).tap()
      return ["performed": true, "delivered": true, "mechanism": "system-coordinate"]
    case "ui.type":
      let target = try element(params, app)
      guard [.textField, .secureTextField, .textView].contains(target.elementType), let text = params["text"] as? String, text.count <= 4096 else {
        throw DriverError(code: "INVALID_ARGUMENT", message: "A text input and text up to 4096 characters are required")
      }
      target.tap()
      if params["clear"] as? Bool != false, let old = target.value as? String {
        target.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
      }
      target.typeText(text)
      return ["performed": true, "delivered": true, "mechanism": "native-keyboard"]
    case "ui.dismissKeyboard":
      let keyboard = app.keyboards.firstMatch
      if keyboard.exists {
        let returnButton = keyboard.buttons["Return"]
        if returnButton.exists { returnButton.tap() } else { keyboard.typeText("\n") }
      }
      return ["dismissed": !app.keyboards.firstMatch.exists, "mechanism": "native-keyboard"]
    case "webview.tap":
      let target = try element(params, app)
      guard target.elementType == .webView, let x = params["x"] as? Double, let y = params["y"] as? Double,
            x.isFinite, y.isFinite, x >= 0, y >= 0, x < target.frame.width, y < target.frame.height else {
        throw DriverError(code: "INVALID_ARGUMENT", message: "WebView testID and in-bounds native point x,y are required")
      }
      let frame = target.frame
      coordinate(app, x: frame.minX + x, y: frame.minY + y).tap()
      return ["performed": true, "delivered": true, "mechanism": "system-coordinate", "coordinates": "webview-local-native-points"]
    default: throw DriverError(code: "UNSUPPORTED", message: "Unsupported driver method: \(method)")
    }
  }

  private func nativeHealth(_ app: XCUIApplication) -> [String: Any] {
    let surface = app.descendants(matching: .any).matching(identifier: "native-surface").firstMatch
    guard surface.exists, let value = surface.value as? String,
          let data = value.data(using: .utf8),
          var health = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return ["healthy": false, "status": "missing native health metadata"]
    }
    health["source"] = "native-host-sticky-errors"
    return health
  }
}
