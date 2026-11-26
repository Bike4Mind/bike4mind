import XCTest

@testable import B4MKit

final class BriefClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  static let readyJSON = """
    {"id":"b1","status":"ready","createdAt":"2026-11-17T01:00:00.123Z","composedAt":"2026-11-17T01:00:05Z",
     "periodStart":"2026-11-16T01:00:00.000Z","periodEnd":"2026-11-17T01:00:00.000Z","headline":"Quiet day",
     "happened":[{"id":"h1","text":"Something happened"}],"handled":[],
     "decisions":[{"id":"d1","text":"Approve it","approval":{"questId":"q1","sessionId":"s1","pendingActionTs":1700000000000}},
                  {"id":"d2","text":"Decide"}]}
    """

  private func client(_ status: Int, _ body: String) -> (BriefClient, FakeTransport) {
    let transport = FakeTransport { _ in (status, Data(body.utf8)) }
    return (BriefClient(baseURL: base, tokens: FakeTokens(), transport: transport), transport)
  }

  func testBriefFetchUsesGetWithBearerAndDecodes() async throws {
    let (client, transport) = client(200, Self.readyJSON)
    let brief = try await client.brief(id: "b1")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/b1")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    XCTAssertEqual(brief.status, .ready)
    XCTAssertEqual(brief.headline, "Quiet day")
    XCTAssertEqual(brief.decisions.count, 2)
    XCTAssertEqual(
      brief.decisions.first?.approval,
      BriefApprovalRef(questID: "q1", sessionID: "s1", pendingActionTs: 1_700_000_000_000))
    XCTAssertNil(brief.decisions.last?.approval)
    XCTAssertNotNil(brief.composedAt)
  }

  func testComposePostsAndListGetsNewestFirst() async throws {
    let composing = Self.readyJSON.replacingOccurrences(of: "\"ready\"", with: "\"composing\"")
    let (client, transport) = client(202, composing)
    let brief = try await client.compose()
    XCTAssertEqual(brief.status, .composing)
    let postRequests = await transport.requests
    let post = try XCTUnwrap(postRequests.first)
    XCTAssertEqual(post.httpMethod, "POST")
    XCTAssertEqual(post.url?.path(), "/api/v1/briefs")

    await transport.respond { _ in (200, Data("{\"briefs\":[\(Self.readyJSON)]}".utf8)) }
    let briefs = try await client.list()
    XCTAssertEqual(briefs.map(\.id), ["b1"])
    let getRequests = await transport.requests
    let get = try XCTUnwrap(getRequests.last)
    XCTAssertEqual(get.httpMethod, "GET")
    XCTAssertEqual(get.url?.path(), "/api/v1/briefs")
  }

  func testObligationSourcedItemDecodes() async throws {
    let json = Self.readyJSON.replacingOccurrences(
      of: #"{"id":"h1","text":"Something happened"}"#,
      with: #"{"id":"h1","text":"Due Dec 5: City Water $120.50","source":{"kind":"obligation","obligationId":"ob-1"}}"#)
    let (client, _) = client(200, json)
    let brief = try await client.brief(id: "b1")
    XCTAssertEqual(brief.happened, [BriefItem(id: "h1", text: "Due Dec 5: City Water $120.50")])
  }

  func testUnknownStatusDecodesToUnknown() async throws {
    let (client, _) = client(200, Self.readyJSON.replacingOccurrences(of: "\"ready\"", with: "\"archived\""))
    let brief = try await client.brief(id: "b1")
    XCTAssertEqual(brief.status, .unknown("archived"))
  }

  func testStatusesMapToAPIError() async {
    let expectations: [(Int, APIError)] = [
      (404, .notFound), (401, .signedOut), (429, .rateLimited), (500, .server(status: 500)),
    ]
    for (status, expected) in expectations {
      let (client, _) = client(status, "{}")
      do {
        _ = try await client.brief(id: "b1")
        XCTFail("expected \(expected) for \(status)")
      } catch {
        XCTAssertEqual(error as? APIError, expected, "status \(status)")
      }
    }
  }

  func testBadJSONIsMalformed() async {
    let (client, _) = client(200, "{\"nope\":true}")
    do {
      _ = try await client.brief(id: "b1")
      XCTFail("expected malformedResponse")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testAnInvalidIdNeverReachesTheNetwork() async {
    let (client, transport) = client(200, Self.readyJSON)
    do {
      _ = try await client.brief(id: "../x")
      XCTFail("expected notFound")
    } catch {
      XCTAssertEqual(error as? APIError, .notFound)
    }
    let count = await transport.requests.count
    XCTAssertEqual(count, 0)
  }

  func testApprovalStateDecodesWithUnknownAndMissingAsResolved() async throws {
    let json = Self.readyJSON
      .replacingOccurrences(
        of: "\"pendingActionTs\":1700000000000}", with: "\"pendingActionTs\":1700000000000,\"state\":\"pending\"}")
    let (pendingClient, _) = client(200, json)
    let pendingBrief = try await pendingClient.brief(id: "b1")
    XCTAssertEqual(pendingBrief.decisions.first?.approval?.state, .pending)

    let (unknownClient, _) = client(
      200, json.replacingOccurrences(of: "\"state\":\"pending\"", with: "\"state\":\"escalated\""))
    let unknownBrief = try await unknownClient.brief(id: "b1")
    XCTAssertEqual(unknownBrief.decisions.first?.approval?.state, .resolved)

    let (missingClient, _) = client(200, Self.readyJSON)
    let missingBrief = try await missingClient.brief(id: "b1")
    XCTAssertEqual(missingBrief.decisions.first?.approval?.state, .resolved)
  }

  func testQuestionDecisionDecodes() async throws {
    let json = Self.readyJSON.replacingOccurrences(
      of: "{\"id\":\"d2\",\"text\":\"Decide\"}",
      with:
        "{\"id\":\"d2\",\"text\":\"Decide\",\"question\":{\"questId\":\"q2\",\"sessionId\":\"s2\",\"options\":[\"A\",\"B\"],\"state\":\"open\"}}"
    )
    let (client, _) = client(200, json)
    let brief = try await client.brief(id: "b1")
    XCTAssertEqual(
      brief.decisions.last?.question,
      BriefQuestionRef(questID: "q2", sessionID: "s2", options: ["A", "B"], state: .open))
  }

  func testReplyPostsTextAndChoiceAndDecodesTheRun() async throws {
    let (client, transport) = client(202, #"{"executionId":"e1","sessionId":"s2"}"#)
    let result = try await client.reply(briefID: "b1", decisionID: "d2", text: "Go", choiceIndex: 1)
    XCTAssertEqual(result, BriefReplyResult(executionID: "e1", sessionID: "s2"))
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/briefs/b1/decisions/d2/reply")
    let body = try XCTUnwrap(request.httpBody)
    let sent = try JSONSerialization.jsonObject(with: body) as? [String: Any]
    XCTAssertEqual(sent?["text"] as? String, "Go")
    XCTAssertEqual(sent?["choiceIndex"] as? Int, 1)
  }

  func testReplyStatusesMapToTypedFailures() async {
    let closedBody = #"{"error":"x","errorCode":"question_closed"}"#
    let busyBody = #"{"error":"Too many agent runs are active."}"#
    let cases: [(Int, String, BriefReplyFailure)] = [
      (409, closedBody, .closed),
      (409, busyBody, .refused("Too many agent runs are active.")),
      (409, "{}", .refused(BriefClient.fallbackRefusal)),
      (400, #"{"error":"Billing changed. Reopen the brief."}"#, .refused("Billing changed. Reopen the brief.")),
      (403, #"{"error":"Tool not allowed."}"#, .refused("Tool not allowed.")),
      (404, "{}", .notFound),
      (503, "{}", .api(.server(status: 503))),
      (502, "{}", .dispatchFailed(BriefClient.fallbackDispatchFailure)),
    ]
    for (status, body, expected) in cases {
      let (client, _) = client(status, body)
      do {
        _ = try await client.reply(briefID: "b1", decisionID: "d2", text: "Go", choiceIndex: nil)
        XCTFail("expected \(expected) for \(status)")
      } catch {
        XCTAssertEqual(error as? BriefReplyFailure, expected, "status \(status)")
      }
    }
  }
  func testDispatchFailurePreservesCheckFirstGuidance() async throws {
    let messages = [
      "Execution e1 could not be confirmed. Check it before starting another run.",
      "The executor rejected this request. Try again in a moment.",
    ]
    for message in messages {
      let body = String(decoding: try JSONSerialization.data(withJSONObject: ["error": message]), as: UTF8.self)
      let (client, _) = client(502, body)
      do {
        _ = try await client.reply(briefID: "b1", decisionID: "d2", text: "Go", choiceIndex: nil)
        XCTFail("expected dispatch failure")
      } catch {
        XCTAssertEqual((error as? BriefReplyFailure)?.message, message)
      }
    }
  }

}
