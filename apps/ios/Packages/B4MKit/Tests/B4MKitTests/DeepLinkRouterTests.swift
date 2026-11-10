import XCTest

@testable import B4MKit

final class DeepLinkRouterTests: XCTestCase {
  private func route(_ string: String) -> Route? {
    DeepLinkRouter.route(url: URL(string: string)!)
  }

  func testSessionURLRoutesToSessionDetail() {
    XCTAssertEqual(route("https://app.bike4mind.com/sessions/65f0c0ffee"), .session(id: "65f0c0ffee"))
  }

  func testNotebookURLRoutesToSessionDetail() {
    XCTAssertEqual(route("https://app.bike4mind.com/notebooks/65f0c0ffee"), .session(id: "65f0c0ffee"))
    XCTAssertEqual(route("https://app.bike4mind.com/sessions/65f0c0ffee"), .session(id: "65f0c0ffee"))
    XCTAssertEqual(route("https://app.bike4mind.com/notebooks"), .sessions)
  }

  func testNotebookPathWithANonIDSuffixStillOpensTheSession() {
    XCTAssertEqual(route("https://app.bike4mind.com/notebooks/abc123/files"), .session(id: "abc123"))
    XCTAssertEqual(route("https://app.bike4mind.com/notebooks/abc123/?tab=chat"), .session(id: "abc123"))
    let malformed = URL(string: "https://app.bike4mind.com/notebooks/..%2F..%2Fadmin")!
    XCTAssertEqual(DeepLinkRouter.route(url: malformed), .web(malformed))
  }

  func testPayloadNotebookDeepLinkRoutes() {
    let payload = NotificationPayload(userInfo: ["deepLink": "https://app.bike4mind.com/notebooks/s1"])
    XCTAssertEqual(payload.route, .session(id: "s1"))
  }

  func testTrailingSlashQueryAndFragmentAreIgnored() {
    XCTAssertEqual(route("https://app.bike4mind.com/sessions/abc123/"), .session(id: "abc123"))
    XCTAssertEqual(route("https://app.bike4mind.com/sessions/abc123?questId=9#top"), .session(id: "abc123"))
  }

  func testHostIsCaseInsensitive() {
    XCTAssertEqual(route("https://APP.Bike4Mind.com/sessions/abc"), .session(id: "abc"))
  }

  func testUnknownHostIsRejected() {
    XCTAssertNil(route("https://evil.example.com/sessions/abc"))
    XCTAssertNil(route("https://app.bike4mind.com.evil.example/sessions/abc"))
    XCTAssertNil(route("https://bike4mind.com/sessions/abc"))
  }

  func testNonHTTPSSchemesAreRejected() {
    XCTAssertNil(route("http://app.bike4mind.com/sessions/abc"))
    XCTAssertNil(route("bike4mind://sessions/abc"))
  }

  func testUserInfoInURLIsRejected() {
    XCTAssertNil(route("https://app.bike4mind.com@evil.example/sessions/abc"))
    XCTAssertNil(route("https://user:pw@app.bike4mind.com/sessions/abc"))
  }

  func testTabRootsRoute() {
    XCTAssertEqual(route("https://app.bike4mind.com/"), .sessions)
    XCTAssertEqual(route("https://app.bike4mind.com"), .sessions)
    XCTAssertEqual(route("https://app.bike4mind.com/sessions"), .sessions)
    XCTAssertEqual(route("https://app.bike4mind.com/lakes"), .lakes)
    let lakeURL = URL(string: "https://app.bike4mind.com/lakes/lake-1?tab=files")!
    XCTAssertEqual(DeepLinkRouter.route(url: lakeURL), .web(lakeURL), "no native lake screen: keep the whole URL")
    XCTAssertEqual(route("https://app.bike4mind.com/media/xyz"), .media)
    XCTAssertEqual(route("https://app.bike4mind.com/settings/notifications"), .settings)
  }

  func testUnknownPathFallsBackToSafari() {
    let url = URL(string: "https://app.bike4mind.com/pricing")!
    XCTAssertEqual(DeepLinkRouter.route(url: url), .web(url))
  }

  func testMalformedIdentifierFallsBackToSafariInsteadOfNavigating() {
    let url = URL(string: "https://app.bike4mind.com/sessions/..%2F..%2Fadmin")!
    XCTAssertEqual(DeepLinkRouter.route(url: url), .web(url))
  }

  func testRoutesKnowTheirTab() {
    XCTAssertEqual(Route.session(id: "a").tab, .sessions)
    XCTAssertNil(Route.lake(id: "a").tab)
    XCTAssertNil(Route.lakes.tab)
    XCTAssertEqual(Route.media.tab, .media)
    XCTAssertEqual(Route.settings.tab, .settings)
    XCTAssertNil(Route.web(URL(string: "https://app.bike4mind.com/x")!).tab)
  }

  // MARK: - Notification payloads

  func testPayloadDeepLinkRoutes() {
    let payload = NotificationPayload(userInfo: [
      "deepLink": "https://app.bike4mind.com/sessions/s1", "questId": "q1", "category": "agent_completed",
    ])
    XCTAssertEqual(payload.route, .session(id: "s1"))
    XCTAssertEqual(payload.questID, "q1")
    XCTAssertEqual(payload.category, .agentCompleted)
  }

  func testPayloadFallsBackToSessionIdWhenDeepLinkMissingOrForeign() {
    XCTAssertEqual(NotificationPayload(userInfo: ["sessionId": "s2"]).route, .session(id: "s2"))
    let foreign = NotificationPayload(userInfo: ["deepLink": "https://evil.example/x", "sessionId": "s3"])
    XCTAssertEqual(foreign.route, .session(id: "s3"))
  }

  func testPayloadWithNothingRoutableHasNoRoute() {
    XCTAssertNil(NotificationPayload(userInfo: ["aps": ["alert": "hi"]]).route)
    XCTAssertNil(NotificationPayload(userInfo: ["deepLink": 42]).route)
  }

  func testCategoryReadsFromApsWhenNotTopLevel() {
    let payload = NotificationPayload(userInfo: ["aps": ["category": "approval_needed"]])
    XCTAssertEqual(payload.category, .approvalNeeded)
  }
}
