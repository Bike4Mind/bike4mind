import XCTest

@testable import B4MKit

@MainActor
final class ForegroundPresentationTests: XCTestCase {
  private let payload = NotificationPayload(
    deepLink: URL(string: "https://app.bike4mind.com/sessions/s1"), sessionID: "s1", category: .chatCompleted)

  func testSuppressedWhenTheSessionIsOnScreen() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "s1"))
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { true })
    XCTAssertEqual(handler.presentation(for: payload), .suppress)
  }

  func testBannerWhenADifferentSessionIsOnScreen() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "other"))
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { true })
    XCTAssertEqual(handler.presentation(for: payload), .banner)
  }

  func testBannerWhenAnotherTabIsSelected() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "s1"))
    navigator.apply(.media)
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { true })
    XCTAssertEqual(handler.presentation(for: payload), .banner)
  }

  func testBannerWhenShellIsLockedOrAppInactive() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "s1"))
    XCTAssertEqual(
      IncomingEventHandler(navigator: navigator, isShellReady: { false }).presentation(for: payload), .banner)
    XCTAssertEqual(
      IncomingEventHandler(navigator: navigator, isShellReady: { true }, isAppActive: { false })
        .presentation(for: payload),
      .banner)
  }

  func testBannerWhenPayloadHasNoRoute() {
    let handler = IncomingEventHandler(navigator: AppNavigator(), isShellReady: { true })
    XCTAssertEqual(handler.presentation(for: NotificationPayload()), .banner)
  }
}
