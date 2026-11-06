import XCTest

final class NativeHostUITests: XCTestCase {
  func testNativeAndEmbeddedWebHitTesting() {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launch()
    let increment = app.buttons["increment"]
    XCTAssertTrue(increment.waitForExistence(timeout: 20), app.debugDescription)
    increment.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(app.staticTexts["Count: 1"].waitForExistence(timeout: 5), app.debugDescription)
    let input = app.textFields["name-input"]
    input.tap()
    input.typeText(" Runner\n")
    app.buttons["echo-button"].tap()
    XCTAssertTrue(app.staticTexts["Echo: Native Runner"].waitForExistence(timeout: 5), app.debugDescription)
    let web = app.webViews["web-primary"]
    XCTAssertTrue(web.waitForExistence(timeout: 15), app.debugDescription)
    let webButton = web.buttons["Web action"]
    XCTAssertTrue(webButton.waitForExistence(timeout: 15), app.debugDescription)
    let frame = webButton.frame
    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY))
    point.tap()
    let result = app.staticTexts["web-result"]
    XCTAssertTrue(result.waitForExistence(timeout: 5))
    XCTAssertTrue(result.label.contains("1"), result.label)
    app.buttons["toggle-overlay"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    point.tap()
    let overlayResult = app.staticTexts["overlay-result"]
    XCTAssertTrue(overlayResult.label.contains("1"), app.debugDescription)
    XCTAssertTrue(result.label.contains("1"), "DOM action must not receive the covered tap: \(result.label)")
    let secondary = app.webViews["web-secondary"].buttons["Web action"]
    XCTAssertTrue(secondary.waitForExistence(timeout: 10), app.debugDescription)
    secondary.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertEqual(app.staticTexts["web-secondary-result"].label, "Secondary: 1")
    XCTAssertEqual(result.label, "Primary: 1", "Independent WebViews must not share message targets")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "UIKit-and-two-embedded-WebViews"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
