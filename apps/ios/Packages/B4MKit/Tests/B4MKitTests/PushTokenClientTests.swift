import XCTest

@testable import B4MKit

final class PushTokenClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  private func body(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testRegisterSendsTheContractBodyWithBearer() async throws {
    let transport = FakeTransport { _ in (204, Data()) }
    let client = PushTokenClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.registerPushToken("abc", environment: .sandbox, appVersion: "0.1.0")

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/push-tokens")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    let json = try body(request)
    XCTAssertEqual(json["token"] as? String, "abc")
    XCTAssertEqual(json["kind"] as? String, "device")
    XCTAssertEqual(json["platform"] as? String, "ios")
    XCTAssertEqual(json["environment"] as? String, "sandbox")
    XCTAssertEqual(json["appVersion"] as? String, "0.1.0")
  }

  func testUnregisterSendsDeleteWithTokenInBody() async throws {
    let transport = FakeTransport { _ in (200, Data()) }
    let client = PushTokenClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.unregisterPushToken("abc")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "DELETE")
    XCTAssertEqual(try body(request)["token"] as? String, "abc")
  }

  func testA401RefreshesOnceAndRetries() async throws {
    let transport = FakeTransport { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1" ? (401, Data()) : (200, Data())
    }
    let tokens = FakeTokens()
    let client = PushTokenClient(baseURL: base, tokens: tokens, transport: transport)
    try await client.registerPushToken("abc", environment: .production, appVersion: nil)
    let count = await transport.requests.count
    let invalidations = await tokens.invalidations
    XCTAssertEqual(count, 2)
    XCTAssertEqual(invalidations, 1)
  }

  func testServerErrorsSurfaceAsAPIError() async {
    let transport = FakeTransport { _ in (500, Data()) }
    let client = PushTokenClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      try await client.registerPushToken("abc", environment: .sandbox, appVersion: nil)
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .server(status: 500))
    }
  }
}
