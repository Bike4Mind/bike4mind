import XCTest

@testable import B4MKit

final class NotificationPayloadTests: XCTestCase {
  func testASessionIdFallbackWithPathPunctuationDoesNotRoute() {
    XCTAssertNil(NotificationPayload(userInfo: ["sessionId": "../settings"]).route)
    XCTAssertNil(NotificationPayload(userInfo: ["sessionId": "a/b"]).route)
    XCTAssertNil(NotificationPayload(userInfo: ["sessionId": ""]).route)
    XCTAssertEqual(
      NotificationPayload(userInfo: ["sessionId": "65f0c0ffee0000000000abcd"]).route,
      .session(id: "65f0c0ffee0000000000abcd"))
  }

  func testABriefReadyPushRoutesToTheBrief() {
    let payload = NotificationPayload(userInfo: [
      "category": "brief_ready", "briefId": "b1", "deepLink": "https://app.bike4mind.com/briefs/b1",
    ])
    XCTAssertEqual(payload.briefID, "b1")
    XCTAssertEqual(payload.route, .brief(id: "b1"))
  }

  func testABriefActionCategoryInApsStillParsesAsABriefReadyPush() {
    let payload = NotificationPayload(userInfo: [
      "aps": ["category": BriefNotificationCategory.approvalIdentifier], "category": "brief_ready", "briefId": "b1",
    ])
    XCTAssertEqual(payload.category, .briefReady)
    XCTAssertEqual(payload.briefID, "b1")
    XCTAssertNil(payload.approval)
    XCTAssertEqual(payload.route, .brief(id: "b1"))
  }

  func testABriefReadyPushWithoutAUsableIdDoesNotRouteToABrief() {
    XCTAssertNil(NotificationPayload(userInfo: ["category": "brief_ready"]).route)
    let malformed = NotificationPayload(userInfo: ["category": "brief_ready", "briefId": "../x"])
    XCTAssertNil(malformed.briefID)
    XCTAssertNil(malformed.route)
  }
}
