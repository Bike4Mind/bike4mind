import XCTest

@testable import B4MKit

final class PendingDecisionClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  private func client(_ responder: @escaping FakeTransport.Responder) -> (PendingDecisionClient, FakeTransport) {
    let transport = FakeTransport(responder: responder)
    return (PendingDecisionClient(baseURL: base, tokens: FakeTokens(), transport: transport), transport)
  }

  func testCountIsABearerGetAndDecodes() async throws {
    let body = #"{"count":3,"approvals":1,"briefDecisions":2,"briefId":"b1"}"#
    let (client, transport) = client { _ in (200, Data(body.utf8)) }

    let count = try await client.pendingDecisionCount()

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/pending-decisions")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    XCTAssertEqual(count, PendingDecisionCount(count: 3, approvals: 1, briefDecisions: 2, briefID: "b1"))
  }

  func testNoBriefYetDecodesANilBrief() async throws {
    let body = #"{"count":0,"approvals":0,"briefDecisions":0,"briefId":null}"#
    let (client, _) = client { _ in (200, Data(body.utf8)) }
    let count = try await client.pendingDecisionCount()
    XCTAssertNil(count.briefID)
    XCTAssertEqual(count.count, 0)
  }

  func testAnErrorStatusIsAnAPIError() async {
    let (client, _) = client { _ in (429, Data(#"{"error":"slow down"}"#.utf8)) }
    do {
      _ = try await client.pendingDecisionCount()
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? APIError, .rateLimited)
    }
  }

  func testAMalformedBodyIsAMalformedResponse() async {
    let (client, _) = client { _ in (200, Data(#"{"count":"three"}"#.utf8)) }
    do {
      _ = try await client.pendingDecisionCount()
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }
}
