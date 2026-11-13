import XCTest

@testable import B4MKit

@MainActor
final class AppNavigatorTests: XCTestCase {
  func testSessionRoutePushesDetailOverWhateverWasOpen() {
    let navigator = AppNavigator()
    navigator.apply(.media)
    navigator.apply(.session(id: "s1"))
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s1"])
  }

  func testANewConversationHandsItsFirstTurnToItsScreenOnce() {
    let navigator = AppNavigator()
    let turn = QuestTurn(id: "q1", prompt: "Hi", reply: nil, status: .pending, createdAt: Date())
    navigator.openNewConversation(sessionID: "s1", firstTurn: turn)
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s1"])
    XCTAssertNil(navigator.takeOpeningTurn(forSession: "s2"))
    XCTAssertEqual(navigator.takeOpeningTurn(forSession: "s1")?.id, "q1")
    XCTAssertNil(navigator.takeOpeningTurn(forSession: "s1"))
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
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s2"])
  }

  func testMediaRoutePushesStudio() {
    let navigator = AppNavigator()
    navigator.apply(.media)
    XCTAssertEqual(navigator.sessionPath, [.studio])
    XCTAssertTrue(navigator.isShowing(.media))
    XCTAssertFalse(navigator.isShowing(.home))
  }

  func testSettingsRoutePushesSettingsOnHome() {
    let navigator = AppNavigator()
    navigator.sessionPath = [.sessionList, .session(.placeholder(id: "s1"))]
    navigator.apply(.settings)
    XCTAssertEqual(navigator.sessionPath, [.settings])
    XCTAssertTrue(navigator.isShowing(.settings))
    // Home's composer drops focus whenever home is covered, Settings included.
    XCTAssertFalse(navigator.isShowing(.home))
    navigator.apply(.media)
    XCTAssertFalse(navigator.isShowing(.settings))
  }

  func testLakesRouteOpensTheWebAndLeavesTheStackAlone() {
    let navigator = AppNavigator()
    navigator.apply(.media)
    navigator.apply(.lakes)
    XCTAssertEqual(navigator.sessionPath, [.studio])
    XCTAssertEqual(navigator.externalURL, URL(string: "https://app.bike4mind.com/lakes"))
    XCTAssertFalse(navigator.isShowing(.lakes))
  }

  func testLakeRouteOpensTheLakeOnTheWebWithoutTouchingTheStack() {
    let navigator = AppNavigator()
    navigator.apply(.lake(id: "l1"))
    XCTAssertTrue(navigator.sessionPath.isEmpty)
    XCTAssertEqual(navigator.externalURL, URL(string: "https://app.bike4mind.com/lakes/l1"))
  }

  func testComposeRequestCarriesAKnownSessionName() {
    let navigator = AppNavigator()
    navigator.apply(.compose(ComposeRequest(target: .session(id: "s1"), sessionName: "Trip plan")))
    XCTAssertEqual(navigator.sessionPath, [.session(.placeholder(id: "s1", name: "Trip plan"))])
  }

  func testHomeRoutePopsToTheStartOfChat() {
    let navigator = AppNavigator()
    navigator.sessionPath = [.sessionList, .session(.placeholder(id: "s1"))]
    navigator.apply(.home)
    XCTAssertTrue(navigator.sessionPath.isEmpty)
    XCTAssertTrue(navigator.isShowing(.home))
  }

  func testHomeIsNotShowingUnderAPush() {
    let navigator = AppNavigator()
    XCTAssertTrue(navigator.isShowing(.home))
    navigator.apply(.session(id: "s1"))
    XCTAssertFalse(navigator.isShowing(.home))
    navigator.apply(.home)
    XCTAssertTrue(navigator.isShowing(.home))
    navigator.apply(.media)
    XCTAssertFalse(navigator.isShowing(.home))
  }

  func testDrawerStateNeverChangesWhetherHomeIsShowing() {
    let navigator = AppNavigator()
    navigator.isDrawerOpen = true
    XCTAssertTrue(navigator.isShowing(.home))
  }

  func testEveryRouteClosesTheDrawer() {
    let routes: [Route] = [
      .home, .sessions, .settings, .media, .session(id: "s1"), .lakes,
      .compose(ComposeRequest(target: .newConversation)),
    ]
    for route in routes {
      let navigator = AppNavigator()
      navigator.isDrawerOpen = true
      navigator.apply(route)
      XCTAssertFalse(navigator.isDrawerOpen, "\(route)")
    }
  }

  func testOpeningARecentNotebookKeepsItsNameAndClosesTheDrawer() {
    let navigator = AppNavigator()
    navigator.isDrawerOpen = true
    let summary = SessionSummary.placeholder(id: "s1", name: "Trip plan")
    navigator.openSession(summary)
    XCTAssertEqual(navigator.sessionPath, [.session(summary)])
    XCTAssertFalse(navigator.isDrawerOpen)
  }

  func testSessionsRouteShowsTheHistoryOnTopOfHome() {
    let navigator = AppNavigator()
    navigator.sessionPath = [.session(.placeholder(id: "s1"))]
    navigator.apply(.sessions)
    XCTAssertEqual(navigator.sessionPath, [.sessionList])
    XCTAssertTrue(navigator.isShowing(.sessions))
    XCTAssertFalse(navigator.isShowing(.home))
  }

  func testSessionOpenedFromTheHistoryKeepsTheHistoryUnderIt() {
    let navigator = AppNavigator()
    navigator.sessionPath = [.sessionList, .session(.placeholder(id: "s1"))]
    navigator.apply(.session(id: "s1"))
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), [nil, "s1"])
    XCTAssertTrue(navigator.isShowing(.session(id: "s1")))
  }

  func testLinkedSessionIsPushedStraightOnHomeSoBackLandsThere() {
    let navigator = AppNavigator()
    navigator.sessionPath = [.sessionList, .session(.placeholder(id: "s1"))]
    navigator.apply(.session(id: "s2"))
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s2"])
  }

  func testNewConversationComposePopsToHomeAndIsTakenExactlyOnce() {
    let navigator = AppNavigator()
    navigator.sessionPath = [.sessionList, .session(.placeholder(id: "s1"))]
    navigator.apply(.compose(ComposeRequest(target: .newConversation, draft: "hi")))
    XCTAssertTrue(navigator.sessionPath.isEmpty)
    XCTAssertNil(navigator.takeComposeRequest(forSession: "s1"))
    XCTAssertEqual(navigator.takeNewConversationRequest()?.draft, "hi")
    XCTAssertNil(navigator.takeNewConversationRequest())
  }

  func testSessionComposeIsNotTakenByTheStartOfChat() {
    let navigator = AppNavigator()
    navigator.apply(.compose(ComposeRequest(target: .session(id: "s1"))))
    XCTAssertNil(navigator.takeNewConversationRequest())
    XCTAssertNotNil(navigator.takeComposeRequest(forSession: "s1"))
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
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["s1"])
    navigator.releasePendingRoute()
    XCTAssertEqual(navigator.sessionPath.count, 1)
  }

  func testResetDiscardsPendingRoute() {
    let navigator = AppNavigator()
    navigator.open(.session(id: "s1"), isShellReady: false)
    navigator.reset()
    navigator.releasePendingRoute()
    XCTAssertTrue(navigator.sessionPath.isEmpty)
  }

  func testResetReturnsToHomeWithNothingPending() {
    let navigator = AppNavigator()
    navigator.apply(.compose(ComposeRequest(target: .session(id: "s1"), sessionName: "Old notebook")))
    navigator.apply(.lakes)
    navigator.isDrawerOpen = true
    navigator.reset()
    XCTAssertTrue(navigator.isShowing(.home))
    XCTAssertFalse(navigator.isDrawerOpen)
    XCTAssertNil(navigator.takeComposeRequest(forSession: "s1"))
    XCTAssertNil(navigator.externalURL)
  }

  func testUniversalLinkAndTapShareTheSamePath() {
    let navigator = AppNavigator()
    let handler = IncomingEventHandler(navigator: navigator, isShellReady: { true })
    XCTAssertTrue(handler.handle(url: URL(string: "https://app.bike4mind.com/sessions/u1")!))
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["u1"])
    handler.didTapNotification(NotificationPayload(sessionID: "t1"))
    XCTAssertEqual(navigator.sessionPath.map(\.sessionID), ["t1"])
    XCTAssertFalse(handler.handle(url: URL(string: "https://evil.example/sessions/x")!))
  }
}
