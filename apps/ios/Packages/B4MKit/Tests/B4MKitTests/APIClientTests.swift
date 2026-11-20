import XCTest

@testable import B4MKit

final class APIClientTests: XCTestCase {
  private let baseURL = URL(string: "https://api.example.test")!

  private func makeClient(
    tokens: FakeTokens, responder: @escaping FakeTransport.Responder
  ) -> (APIClient, FakeTransport) {
    let transport = FakeTransport(responder: responder)
    return (APIClient(baseURL: baseURL, tokens: tokens, transport: transport), transport)
  }

  private static func ok(_ body: String) -> (status: Int, body: Data) { (200, Data(body.utf8)) }

  // MARK: - Bearer injection

  func testRequestsCarryTheBearerTokenAndQuery() async throws {
    let tokens = FakeTokens([.success("abc.def")])
    let (client, transport) = makeClient(tokens: tokens) { _ in Self.ok(APIFixtures.sessionsPage1) }

    _ = try await client.listSessions(cursor: "c1", limit: 10)

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc.def")
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/sessions")
    let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
    XCTAssertEqual(Set(query?.map { "\($0.name)=\($0.value ?? "")" } ?? []), ["limit=10", "cursor=c1"])
  }

  func testSessionIDIsPercentEncodedIntoThePath() async throws {
    let tokens = FakeTokens([.success("t")])
    let (client, transport) = makeClient(tokens: tokens) { _ in Self.ok(APIFixtures.quests) }

    _ = try await client.listSessionQuests(sessionID: "a b/c", cursor: nil, limit: 5)

    let requests = await transport.requests
    let url = try XCTUnwrap(requests.first?.url)
    XCTAssertEqual(url.path(percentEncoded: true), "/api/v1/sessions/a%20b%2Fc/quests")
  }

  // MARK: - 401 handling

  func testA401IsRetriedOnceWithAFreshToken() async throws {
    let tokens = FakeTokens([.success("stale"), .success("fresh")])
    let (client, transport) = makeClient(tokens: tokens) { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh"
        ? Self.ok(APIFixtures.credits) : (401, Data(APIFixtures.errorBody.utf8))
    }

    let balance = try await client.creditBalance()

    XCTAssertEqual(balance.credits, 31667)
    let sent = await transport.requests.map { $0.value(forHTTPHeaderField: "Authorization") }
    XCTAssertEqual(sent, ["Bearer stale", "Bearer fresh"])
    let invalidations = await tokens.invalidations
    let rejections = await tokens.rejections
    XCTAssertEqual(invalidations, 1)
    XCTAssertEqual(rejections, 0)
  }

  func testASecond401SignsOutAndDoesNotRetryAgain() async throws {
    let tokens = FakeTokens([.success("a"), .success("b"), .success("c")])
    let (client, transport) = makeClient(tokens: tokens) { _ in (401, Data(APIFixtures.errorBody.utf8)) }

    do {
      _ = try await client.creditBalance()
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? APIError, .signedOut)
    }

    let sent = await transport.requests.count
    let rejections = await tokens.rejections
    XCTAssertEqual(sent, 2, "exactly one retry")
    XCTAssertEqual(rejections, 1, "the session is reported dead once")
  }

  func testNoSessionFailsWithoutTouchingTheNetwork() async {
    let tokens = FakeTokens([.failure(AuthError.signedOut)])
    let (client, transport) = makeClient(tokens: tokens) { _ in Self.ok(APIFixtures.credits) }

    do {
      _ = try await client.creditBalance()
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? APIError, .signedOut)
    }
    let sent = await transport.requests.count
    XCTAssertEqual(sent, 0)
  }

  func testARejectedRefreshDuringTheRetryMapsToSignedOut() async {
    let tokens = FakeTokens([.success("stale"), .failure(AuthError.refreshRejected)])
    let (client, _) = makeClient(tokens: tokens) { _ in (401, Data()) }

    do {
      _ = try await client.creditBalance()
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? APIError, .signedOut)
    }
  }

  // MARK: - Error mapping

  func testStatusesMapToDomainErrors() async {
    let cases: [(Int, APIError)] = [
      (403, .forbidden), (404, .notFound), (429, .rateLimited), (503, .server(status: 503)),
    ]
    for (status, expected) in cases {
      let (client, _) = makeClient(tokens: FakeTokens([.success("t")])) { _ in
        (status, Data(APIFixtures.errorBody.utf8))
      }
      do {
        _ = try await client.listSessionQuests(sessionID: "s", cursor: nil, limit: 1)
        XCTFail("expected \(expected) for \(status)")
      } catch {
        XCTAssertEqual(error as? APIError, expected, "status \(status)")
      }
    }
  }

  func testTransportFailureMapsToOffline() async {
    let (client, _) = makeClient(tokens: FakeTokens([.success("t")])) { _ in throw URLError(.notConnectedToInternet) }
    do {
      _ = try await client.creditBalance()
      XCTFail("expected offline")
    } catch {
      XCTAssertEqual(error as? APIError, .offline)
    }
  }

  func testUndecodableBodyMapsToMalformedResponse() async {
    let (client, _) = makeClient(tokens: FakeTokens([.success("t")])) { _ in (200, Data("<html>".utf8)) }
    do {
      _ = try await client.creditBalance()
      XCTFail("expected malformedResponse")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  // MARK: - Fixture decoding

  func testListSessionsFixtureDecodes() async throws {
    let (client, _) = makeClient(tokens: FakeTokens([.success("t")])) { _ in Self.ok(APIFixtures.sessionsPage1) }

    let page = try await client.listSessions(cursor: nil, limit: 25)

    XCTAssertEqual(page.items.map(\.id), ["s-new", "s-old"])
    XCTAssertEqual(page.nextCursor, "cursor-2")
    XCTAssertEqual(page.items[0].name, "Trip planning")
    XCTAssertEqual(page.items[0].lastUsedModel, "claude-sonnet-4")
    XCTAssertNil(page.items[1].lastUsedModel)
    // Dates with and without fractional seconds both parse.
    XCTAssertEqual(page.items[0].lastUpdated.timeIntervalSince1970, 1_793_439_015.456, accuracy: 0.001)
    XCTAssertEqual(page.items[1].lastUpdated, ISO8601DateFormatter().date(from: "2026-10-02T08:00:00Z"))
  }

  func testListSessionQuestsFixtureDecodes() async throws {
    let (client, _) = makeClient(tokens: FakeTokens([.success("t")])) { _ in Self.ok(APIFixtures.quests) }

    let page = try await client.listSessionQuests(sessionID: "s", cursor: nil, limit: 25)

    XCTAssertEqual(page.items.map(\.id), ["q1", "q2", "q3", "q4", "q5"], "server order is preserved")
    XCTAssertNil(page.nextCursor)

    let done = page.items[0]
    XCTAssertEqual(done.reply, "Hi **there**")
    XCTAssertEqual(done.status, .done)
    XCTAssertEqual(done.kind, .message)
    XCTAssertEqual(done.creditsUsed, 12.5)

    XCTAssertNil(page.items[1].reply)
    XCTAssertEqual(page.items[1].status, .running)

    let approval = try XCTUnwrap(page.items[2].pendingAction)
    XCTAssertEqual(approval.tool, "file_delete")
    XCTAssertEqual(approval.parameters["path"], "/tmp/a.txt")
    XCTAssertEqual(approval.requestedAt, Date(timeIntervalSince1970: 1_793_437_320))

    XCTAssertEqual(page.items[3].kind, .error)
    XCTAssertEqual(page.items[3].errorCode, .insufficientCredits)

    XCTAssertNil(page.items[4].prompt)
    XCTAssertNil(page.items[4].status)
  }

  func testCreditBalanceFixtureDecodes() async throws {
    let (client, _) = makeClient(tokens: FakeTokens([.success("t")])) { _ in Self.ok(APIFixtures.credits) }
    let balance = try await client.creditBalance()
    XCTAssertEqual(balance.credits, 31667)
  }
}
