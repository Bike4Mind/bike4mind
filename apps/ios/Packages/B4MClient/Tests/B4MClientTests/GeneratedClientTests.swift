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
    XCTAssertEqual(response.data.first?._type, "voice_transcript")
  }

  /// A value the server adds after this binary shipped must not fail the decode of the whole page.
  func testUnknownEnumValuesDecode() throws {
    let json = """
      {"data": [{"id": "q", "reply": "r", "status": "queued_for_review", "type": "tool_call",
        "errorCode": "quota_exhausted", "createdAt": "2026-10-31T09:00:00Z"}], "next_cursor": null}
      """
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let response = try decoder.decode(
      Components.Schemas.ListSessionQuestsResponse200.self, from: Data(json.utf8))
    XCTAssertEqual(response.data.first?.status, "queued_for_review")
    XCTAssertEqual(response.data.first?.errorCode, "quota_exhausted")
  }

  /// Scripts/open_enums.py strips string enums before generation; a closed enum here means the
  /// generator ran without it.
  func testNoGeneratedEnumIsClosed() throws {
    let generated = URL(filePath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appending(path: "Sources/B4MClient/Generated")
    let files = try FileManager.default.contentsOfDirectory(at: generated, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }
    XCTAssertFalse(files.isEmpty)
    for file in files {
      let source = try String(contentsOf: file, encoding: .utf8)
      XCTAssertNil(
        source.range(of: #"enum \w+: String, Codable"#, options: .regularExpression),
        "\(file.lastPathComponent) has a closed string enum")
    }
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
