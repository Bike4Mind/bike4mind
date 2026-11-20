import XCTest

@testable import B4MKit

final class InstructionClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  private static let instructionJSON = """
    {"id":"i1","text":"Lead with invoices","createdAt":"2026-11-17T01:00:00.123Z"}
    """

  private func client(_ status: Int, _ body: String = "") -> (InstructionClient, FakeTransport) {
    let transport = FakeTransport { _ in (status, Data(body.utf8)) }
    return (InstructionClient(baseURL: base, tokens: FakeTokens(), transport: transport), transport)
  }

  func testListGetsWithBearerAndDecodes() async throws {
    let (client, transport) = client(200, #"{"instructions":[\#(Self.instructionJSON)]}"#)
    let instructions = try await client.list()
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/assistant/instructions")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    XCTAssertEqual(instructions.map(\.id), ["i1"])
    XCTAssertEqual(instructions.first?.text, "Lead with invoices")
  }

  func testAddPostsTextAsJSON() async throws {
    let (client, transport) = client(201, Self.instructionJSON)
    let saved = try await client.add(text: "Lead with invoices")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/assistant/instructions")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String]
    XCTAssertEqual(body, ["text": "Lead with invoices"])
    XCTAssertEqual(saved.id, "i1")
  }

  func testAddMapsLimitAndValidationRefusals() async {
    let (atLimit, _) = client(400, #"{"error":"Too many","errorCode":"instruction_limit_reached"}"#)
    await assertThrows(.limitReached) { _ = try await atLimit.add(text: "x") }
    let (badJSON, _) = client(400, #"{"error":"Bad JSON"}"#)
    await assertThrows(.api(.server(status: 400))) { _ = try await badJSON.add(text: "x") }
    let (invalid, _) = client(422, #"{"error":"Too long"}"#)
    await assertThrows(.invalidText) { _ = try await invalid.add(text: "x") }
  }

  func testRemoveDeletesByIdAndTreatsMissingAsDone() async throws {
    let (api, transport) = client(204)
    try await api.remove(id: "i1")
    let requests = await transport.requests
    XCTAssertEqual(requests.first?.httpMethod, "DELETE")
    XCTAssertEqual(requests.first?.url?.path(), "/api/v1/assistant/instructions/i1")

    let (gone, _) = client(404)
    try await gone.remove(id: "i1")
    let (failing, _) = client(500)
    await assertThrows(.api(.server(status: 500))) { try await failing.remove(id: "i1") }
  }

  func testRemoveSkipsTheRequestForAnUnsafeId() async throws {
    let (client, transport) = client(204)
    try await client.remove(id: "../briefs")
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }

  private func assertThrows(
    _ expected: InstructionError, file: StaticString = #filePath, line: UInt = #line,
    _ body: () async throws -> Void
  ) async {
    do {
      try await body()
      XCTFail("Expected \(expected)", file: file, line: line)
    } catch {
      XCTAssertEqual(error as? InstructionError, expected, file: file, line: line)
    }
  }
}
