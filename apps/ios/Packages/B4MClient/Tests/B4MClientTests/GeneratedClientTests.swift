import Foundation
import XCTest

@testable import B4MClient

/// The generated types are not worth testing line by line; these pin the contract the app relies on.
final class GeneratedClientTests: XCTestCase {
  func testSessionQuestsPayloadDecodesWireNames() throws {
    let json = """
      {"data": [{"id": "q", "prompt": null, "reply": "r", "status": "done", "type": "voice_transcript",
        "createdAt": "2026-10-31T09:00:00Z"}], "next_cursor": "abc"}
      """
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let response = try decoder.decode(
      Components.Schemas.ListSessionQuestsResponse200.self, from: Data(json.utf8))
    XCTAssertEqual(response.nextCursor, "abc")
    XCTAssertEqual(response.data.first?._type, .voiceTranscript)
  }

  func testCreditBalanceIsANumber() throws {
    let response = try JSONDecoder().decode(
      Components.Schemas.GetCreditBalanceResponse200.self, from: Data(#"{"balance": 12.5}"#.utf8))
    XCTAssertEqual(response.balance, 12.5)
  }

  func testOnlyFilteredOperationsAreGenerated() {
    XCTAssertEqual(Operations.ListSessions.id, "listSessions")
    XCTAssertEqual(Operations.ListSessionQuests.id, "listSessionQuests")
    XCTAssertEqual(Operations.GetCreditBalance.id, "getCreditBalance")
  }
}
