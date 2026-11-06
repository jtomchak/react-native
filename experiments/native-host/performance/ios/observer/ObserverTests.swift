import XCTest
import Darwin

// This server exists only inside the XCTest runner, never the app binary.
final class ObserverTests: XCTestCase {
  struct DriverError: Error {
    let code: String
    let message: String
  }

  func testObserverSession() throws {
    continueAfterFailure = false
    let environment = ProcessInfo.processInfo.environment
    guard environment["NH_OBSERVER_ENABLED"] == "1" else {
      throw XCTSkip("Driver is started explicitly by driver.sh")
    }
    let token = environment["NH_OBSERVER_TOKEN"] ?? ""
    guard token.count >= 24, !token.contains("${") else {
      throw DriverError(code: "CONFIGURATION", message: "A driver token of at least 24 characters is required")
    }
    let port = UInt16(environment["NH_OBSERVER_PORT"] ?? "19846") ?? 19846
    let lifetime = min(7200, max(30, Double(environment["NH_OBSERVER_TIMEOUT"] ?? "1800") ?? 1800))
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
    print("NATIVE_PERFORMANCE_OBSERVER_READY 127.0.0.1:\(port)")
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
              response = ["id": requestID, "result": try command(method, params)]
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

  private let allowedPackages: Set<String> = ["dev.nativehost.prototype", "com.meta.RNTester.localDevelopment"]

  private func application(_ params: [String: Any]) throws -> (XCUIApplication, String) {
    guard let package = params["package"] as? String, allowedPackages.contains(package) else {
      throw DriverError(code: "INVALID_PACKAGE", message: "Select an allowed candidate or RNTester bundle identifier")
    }
    return (XCUIApplication(bundleIdentifier: package), package)
  }

  private func element(_ params: [String: Any], _ app: XCUIApplication) throws -> XCUIElement {
    let selector = params["selector"] as? [String: Any] ?? params
    var clauses: [NSPredicate] = []
    for key in ["testID", "resourceID", "label", "text"] {
      guard let value = selector[key] as? String else { continue }
      if key == "testID" || key == "resourceID" { clauses.append(NSPredicate(format: "identifier == %@", value)) }
      else if key == "label" { clauses.append(NSPredicate(format: "label == %@", value)) }
      else { clauses.append(NSPredicate(format: "label == %@ OR value == %@", value, value)) }
    }
    guard !clauses.isEmpty else { throw DriverError(code: "INVALID_SELECTOR", message: "An exact testID, resourceID, text or label selector is required") }
    return app.descendants(matching: .any).matching(NSCompoundPredicate(andPredicateWithSubpredicates: clauses)).firstMatch
  }

  private func describe(_ node: XCUIElementSnapshot, package: String, rootFrame: CGRect) -> [String: Any] {
    let frame = node.frame
    let value = node.value as? String ?? ""
    let editable = [.textField, .secureTextField, .textView].contains(node.elementType)
    return ["exists": true, "text": editable ? value : (value.isEmpty ? node.label : value),
            "label": node.label, "resourceID": node.identifier, "testID": node.identifier,
            "className": String(describing: node.elementType), "package": package,
            "visible": !frame.isEmpty && frame.intersects(rootFrame), "enabled": node.isEnabled,
            "clickable": node.elementType == .button, "scrollable": [.scrollView, .table, .collectionView].contains(node.elementType),
            "bounds": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
            "observedAtElapsedRealtimeNanos": DispatchTime.now().uptimeNanoseconds]
  }

  private func command(_ method: String, _ params: [String: Any]) throws -> Any {
    if method == "session.describe" {
      return ["backend": "ios-xctest-observer", "platform": "ios", "mechanism": "system-accessibility-and-coordinate",
              "independentProcess": true, "observerPID": ProcessInfo.processInfo.processIdentifier, "targetHost": "none", "transport": "loopback-ndjson",
              "allowedPackages": Array(allowedPackages).sorted(), "testOnly": true,
              "capabilities": ["ui.waitFor", "ui.find", "ui.text", "ui.tap", "ui.type", "ui.scroll", "ui.dismissKeyboard", "ui.snapshot", "ui.screenshot"],
              "clock": "DispatchTime.uptimeNanoseconds", "measurementLimit": "Accessibility observation includes XCTest query and IPC latency; it is not a display-frame timestamp"]
    }
    let (app, package) = try application(params)
    // XCTest updates application state asynchronously; socket I/O must not starve its run loop.
    RunLoop.current.run(until: Date().addingTimeInterval(0.005))
    if method == "ui.waitFor" {
      let timeout = min(120_000, max(0, params["timeoutMs"] as? Double ?? 10_000)) / 1000
      let started = DispatchTime.now().uptimeNanoseconds
      let deadline = Date().addingTimeInterval(timeout)
      repeat {
        if app.state == .runningForeground {
          let target = try element(params, app)
          if target.exists {
            var node = describe(try target.snapshot(), package: package, rootFrame: app.frame)
            node["waitDurationNanos"] = DispatchTime.now().uptimeNanoseconds - started
            return node
          }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      } while Date() < deadline
      throw DriverError(code: "TIMEOUT", message: "Exact accessible selector was not observed before timeout")
    }
    if app.state != .runningForeground {
      if method == "ui.find" { return ["exists": false, "package": package] }
      throw DriverError(code: "APP_NOT_FOREGROUND", message: "The selected app is not running in the foreground")
    }
    if method == "ui.screenshot" {
      let png = app.screenshot().pngRepresentation
      guard png.count <= 4 * 1024 * 1024 else {
        throw DriverError(code: "SCREENSHOT_LIMIT", message: "PNG exceeds the 4 MiB observation bound")
      }
      return ["mimeType": "image/png", "byteLength": png.count, "base64": png.base64EncodedString(),
              "mechanism": "XCUIApplication.screenshot", "observedAtElapsedRealtimeNanos": DispatchTime.now().uptimeNanoseconds]
    }
    if method == "ui.snapshot" {
      let root = try app.snapshot()
      var nodes: [[String: Any]] = []
      func visit(_ node: XCUIElementSnapshot) {
        guard nodes.count < 4096 else { return }
        if !node.identifier.isEmpty || !node.label.isEmpty { nodes.append(describe(node, package: package, rootFrame: root.frame)) }
        for child in node.children { visit(child) }
      }
      visit(root)
      return ["nodes": nodes, "package": package, "timestamp": DispatchTime.now().uptimeNanoseconds]
    }
    if method == "ui.dismissKeyboard" {
      if app.keyboards.firstMatch.exists {
        let keyboard = app.keyboards.firstMatch
        let returnButton = keyboard.buttons["Return"].exists ? keyboard.buttons["Return"] : keyboard.buttons["return"]
        if returnButton.exists { returnButton.tap() } else { throw DriverError(code: "UNSUPPORTED", message: "No accessible Return key") }
      }
      return ["performed": true]
    }
    if method == "ui.scroll" {
      let target: XCUIElement = params["selector"] == nil ? app : try element(params, app)
      let direction = params["direction"] as? String ?? "down"
      if direction == "down" { target.swipeUp() }
      else if direction == "up" { target.swipeDown() }
      else { throw DriverError(code: "INVALID_ARGUMENT", message: "Scroll direction must be up or down") }
      return ["performed": true, "mechanism": "XCTest-native-swipe", "durationControl": "XCTest-default"]
    }
    let selection = method == "ui.type" && params["selector"] == nil ? params.filter { $0.key != "text" } : params
    let target = try element(selection, app)
    guard target.exists else {
      if method == "ui.find" { return ["exists": false, "package": package] }
      throw DriverError(code: "NOT_FOUND", message: "No accessible element matched")
    }
    let node = describe(try target.snapshot(), package: package, rootFrame: app.frame)
    switch method {
    case "ui.find": return node
    case "ui.text": return ["text": node["text"] ?? "", "label": node["label"] ?? ""]
    case "ui.tap":
      guard target.isHittable else { throw DriverError(code: "NOT_HITTABLE", message: "Element is not hittable") }
      target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      return ["performed": true, "bounds": node["bounds"] ?? [:]]
    case "ui.type":
      guard let text = params["text"] as? String, text.utf8.count <= 16_384 else {
        throw DriverError(code: "INVALID_ARGUMENT", message: "Text must be a string at most 16 KiB")
      }
      target.tap()
      if params["clear"] as? Bool != false {
        let current = target.value as? String ?? ""
        target.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
      }
      target.typeText(text)
      return ["performed": true]
    default: throw DriverError(code: "UNSUPPORTED", message: "Unsupported observer command")
    }
  }
}
