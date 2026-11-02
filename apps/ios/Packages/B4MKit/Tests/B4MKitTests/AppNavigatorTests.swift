import XCTest

@testable import B4MKit

@MainActor
final class AppNavigatorTests: XCTestCase {
  func testSessionRouteSelectsTabAndPushesDetail() {
    let navigator = AppNavigator()
    navigator.selectedTab = .settings
    navigator.apply(.session(id: "s1"))
    XCTAssertEqual(navigator.selectedTab, .sessions)
    XCTAssertEqual(navigator.sessionPath.map(\.id), ["s1"])
  }

  func testSameSessionDoesNotStackTwice() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "s1"))
    navigator.apply(.session(id: "s1"))
    XCTAssertEqual(navigator.sessionPath.count, 1)
  }

  func testDifferentSessionReplacesTheStack() {
    let navigator = AppNavigator()
    navigator.apply(.session(id: "s1"))
    navigator.apply(.session(id: "s2"))
    XCTAssertEqual(navigator.sessionPath.map(\.id), ["s2"])
  }

  func testTabRootsSelectTheirTab() {
    let navigator = AppNavigator()
    navigator.apply(.lake(id: "l1"))
    XCTAssertEqual(navigator.selectedTab, .lakes)
    navigator.apply(.media)
    XCTAssertEqual(navigator.selectedTab, .media)
    navigator.apply(.settings)
    XCTAssertEqual(navigator.selectedTab, .settings)
  }

  func testWebRouteSurfacesExternalURLOnce() {
    let navigator = AppNavigator()
    let url = URL(string: "https://app.bike4mind.com/pricing")!
    navigator.apply(.web(url))
    XCTAssertEqual(navigator.externalURL, url)
    navigator.consumeExternalURL()
    XCTAssertNil(navigator.externalURL)
  }

  func testRouteBeforeShellIsReadyWaitsThenApplies() {
    let navigator = AppNavigator()
    navigator.open(.session(id: "s1"), isShellReady: false)
    XCTAssertTrue(navigator.sessionPath.isEmpty)
    navigator.releasePendingRoute()
    XCTAssertEqual(navigator.sessionPath.map(\.id), ["s1"])
    navigator.releasePendingRoute()
    XCTAssertEqual(navigator.sessionPath.count, 1)
  }

  func testDiscardedPendingRouteNeverApplies() {
    let navigator = AppNavigator()
    navigator.open(.session(id: "s1"), isShellReady: false)
    navigator.discardPendingRoute()
    navigator.releasePendingRoute()
    XCTAssertTrue(navigator.sessionPath.isEmpty)
  }

  func testUniversalLinkAndTapShareTheSamePath() {
    let navigator = AppNavigator()
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { true })
    XCTAssertTrue(handler.handle(url: URL(string: "https://app.bike4mind.com/sessions/u1")!))
    XCTAssertEqual(navigator.sessionPath.map(\.id), ["u1"])
    handler.didTapNotification(NotificationPayload(sessionID: "t1"))
    XCTAssertEqual(navigator.sessionPath.map(\.id), ["t1"])
    XCTAssertFalse(handler.handle(url: URL(string: "https://evil.example/sessions/x")!))
  }
}
