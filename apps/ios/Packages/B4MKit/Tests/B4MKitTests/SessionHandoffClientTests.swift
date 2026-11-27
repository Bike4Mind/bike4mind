import XCTest

@testable import B4MKit

final class SessionHandoffClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  func testSendUsesSharedContractAndBearerWithoutContent() async throws {
    let transport = FakeTransport { _ in (200, Data()) }
    let client = SessionHandoffClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.send(sessionID: "0123456789abcdef01234567", deviceID: "live:one")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/v1/session-handoffs")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
    XCTAssertEqual(json, ["sessionId": "0123456789abcdef01234567", "deviceId": "live:one"])
  }

  func testInactiveDestinationSurfaces409() async {
    let client = SessionHandoffClient(
      baseURL: base, tokens: FakeTokens(), transport: FakeTransport { _ in (409, Data()) })
    do {
      try await client.send(sessionID: "0123456789abcdef01234567", deviceID: "live:one")
      XCTFail("Expected inactive destination")
    } catch { XCTAssertEqual(error as? APIError, .server(status: 409)) }
  }
}
