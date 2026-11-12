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
}
