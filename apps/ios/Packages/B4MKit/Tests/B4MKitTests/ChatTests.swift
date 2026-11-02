import XCTest

@testable import B4MKit

final class ChatFrameTests: XCTestCase {
  private func streamed(_ quest: JSONObject, statusMessage: String = "") -> ActionFrame {
    ActionFrame(
      action: "streamed_chat_completion",
      payload: ["action": "streamed_chat_completion", "quest": .object(quest), "statusMessage": .string(statusMessage)])
  }

  func testParsesTheOptimizedStatusManagerPayload() throws {
    let frame = try XCTUnwrap(
      ChatQuestFrame(
        streamed(
          [
            "id": "q1", "sessionId": "s1", "reply": "Hello", "replies": [], "creditsUsed": 3, "type": "message",
            "status": "running", "prompt": "Hi", "updatedAt": "2026-11-02T00:00:00Z", "images": [],
          ], statusMessage: "Thinking")))
    XCTAssertEqual(frame.questID, "q1")
    XCTAssertEqual(frame.sessionID, "s1")
    XCTAssertEqual(frame.reply, "Hello")
    XCTAssertEqual(frame.status, .running)
    XCTAssertEqual(frame.kind, .message)
    XCTAssertEqual(frame.creditsUsed, 3)
    XCTAssertEqual(frame.prompt, "Hi")
    XCTAssertEqual(frame.statusMessage, "Thinking")
    XCTAssertNil(frame.pendingAction)
  }

  func testParsesPendingActionAndErrorCode() throws {
    let frame = try XCTUnwrap(
      ChatQuestFrame(
        streamed([
          "id": "q1", "sessionId": "s1", "reply": nil, "status": "running", "type": "error",
          "errorCode": "insufficient_credits",
          "pendingAction": [
            "tool": "web_browse", "params": ["url": "https://x.test", "depth": 2], "ts": 1_800_000_000_000,
          ],
        ])))
    XCTAssertEqual(frame.kind, .error)
    XCTAssertEqual(frame.errorCode, .insufficientCredits)
    XCTAssertEqual(frame.pendingAction?.tool, "web_browse")
    XCTAssertEqual(frame.pendingAction?.parameters, ["url": "https://x.test", "depth": "2"])
    XCTAssertEqual(frame.pendingAction?.requestedAt, Date(timeIntervalSince1970: 1_800_000_000))
  }

  func testOtherActionsAndIncompleteFramesAreNotChat() {
    XCTAssertNil(ChatQuestFrame(ActionFrame(action: "streamed_rapid_reply", payload: ["questId": "q1"])))
    XCTAssertNil(ChatQuestFrame(streamed(["id": "q1", "reply": "no session"])))
    XCTAssertNil(ChatQuestFrame(ActionFrame(action: "streamed_chat_completion", payload: ["quest": "nope"])))
  }

  func testStreamFiltersBySession() {
    let mine = RealtimeEvent.frame(streamed(["id": "q1", "sessionId": "s1", "reply": "a"]))
    let theirs = RealtimeEvent.frame(streamed(["id": "q2", "sessionId": "s2", "reply": "b"]))
    XCTAssertEqual(ChatStream.frame(in: mine, sessionID: "s1")?.questID, "q1")
    XCTAssertNil(ChatStream.frame(in: theirs, sessionID: "s1"))
    XCTAssertEqual(ChatStream.frame(in: theirs, sessionID: nil)?.questID, "q2")
    XCTAssertNil(ChatStream.frame(in: .refetchNeeded, sessionID: nil))
  }

  func testUpdatesStreamSkipsOtherActionsAndSessions() async {
    let realtime = FakeRealtime()
    let updates = await ChatStream.updates(from: realtime, sessionID: "s1")
    await realtime.emit(.frame(ActionFrame(action: "agent_text_delta", payload: [:])))
    await realtime.emit(.frame(streamed(["id": "q2", "sessionId": "s2", "reply": "other"])))
    await realtime.emit(.frame(streamed(["id": "q1", "sessionId": "s1", "reply": "mine"])))

    var iterator = updates.makeAsyncIterator()
    let first = await iterator.next()
    XCTAssertEqual(first?.questID, "q1")
    XCTAssertEqual(first?.reply, "mine")
  }

  func testCumulativeReplyReplacesNeverAppends() {
    var turn = QuestTurn(id: "q1", prompt: "Hi", reply: nil, status: .pending, createdAt: Samples.date)
    for (reply, expected) in [
      ("Hel", "Hel"), ("Hello wor", "Hello wor"), ("Hello", "Hello"), ("Hello world!", "Hello world!"),
    ] {
      turn = turn.applying(ChatQuestFrame(questID: "q1", sessionID: "s1", reply: reply, status: .running))
      XCTAssertEqual(turn.reply, expected, "a shrinking or growing reply is shown exactly as sent")
    }
    XCTAssertEqual(turn.prompt, "Hi")
  }

  func testOptimizedFramesKeepFieldsTheyOmit() {
    let turn = QuestTurn(
      id: "q1", prompt: "Hi", reply: "x", status: .running, kind: .error, errorCode: .spendCapExceeded,
      createdAt: Samples.date, creditsUsed: 4)
    let next = turn.applying(ChatQuestFrame(questID: "q1", sessionID: "s1", reply: nil, status: nil, kind: nil))
    XCTAssertEqual(next.reply, "x")
    XCTAssertEqual(next.status, .running)
    XCTAssertEqual(next.errorCode, .spendCapExceeded)
    XCTAssertEqual(next.creditsUsed, 4)
  }
}

final class ApprovalStateTests: XCTestCase {
  private let action = PendingAction(tool: "web_browse", parameters: [:], requestedAt: Samples.date)

  func testMapping() {
    XCTAssertEqual(ApprovalState(pendingAction: nil, status: .running, at: Samples.date), .none)
    XCTAssertEqual(ApprovalState(pendingAction: action, status: .running, at: Samples.date), .awaiting(action))
    XCTAssertEqual(ApprovalState(pendingAction: action, status: .pending, at: Samples.date), .awaiting(action))
    XCTAssertEqual(
      ApprovalState(pendingAction: action, status: .running, at: Samples.date.addingTimeInterval(15 * 60 + 1)),
      .lapsed(action))
    XCTAssertEqual(
      ApprovalState(pendingAction: action, status: .done, at: Samples.date), .none, "settled turns ask nothing")
    XCTAssertFalse(ApprovalState.canRespondInApp, "approve/deny is not in the public contract yet")
  }

  func testPendingActionFrameDrivesTheBadgeAndClearsWhenResolved() {
    var turn = QuestTurn(id: "q1", prompt: "p", reply: "", status: .running, createdAt: Samples.date)
    turn = turn.applying(
      ChatQuestFrame(questID: "q1", sessionID: "s1", reply: "", status: .running, pendingAction: action))
    XCTAssertEqual(TranscriptMapper.messages(for: turn).last?.badge, .awaitingApproval)

    turn = turn.applying(ChatQuestFrame(questID: "q1", sessionID: "s1", reply: "Done", status: .running))
    XCTAssertNil(turn.pendingAction)
    XCTAssertEqual(TranscriptMapper.messages(for: turn).last?.badge, .working)
  }
}

final class ChatHapticTests: XCTestCase {
  private func turn(
    _ status: QuestTurn.Status?, kind: QuestTurn.Kind = .message, pending: PendingAction? = nil
  ) -> QuestTurn {
    QuestTurn(
      id: "q", prompt: "p", reply: "", status: status, kind: kind, createdAt: Samples.date, pendingAction: pending)
  }

  func testTransitions() {
    let action = PendingAction(tool: "t", parameters: [:], requestedAt: Samples.date)
    XCTAssertEqual(ChatHaptic.transition(from: turn(.pending), to: turn(.running)), .started)
    XCTAssertNil(ChatHaptic.transition(from: turn(.running), to: turn(.running)), "streaming text is not a tick")
    XCTAssertEqual(ChatHaptic.transition(from: turn(.running), to: turn(.running, pending: action)), .needsAttention)
    XCTAssertNil(ChatHaptic.transition(from: turn(.running, pending: action), to: turn(.running, pending: action)))
    XCTAssertEqual(ChatHaptic.transition(from: turn(.running), to: turn(.done)), .finished)
    XCTAssertEqual(ChatHaptic.transition(from: turn(.running), to: turn(.stopped)), .failed)
    XCTAssertEqual(ChatHaptic.transition(from: turn(.running), to: turn(.done, kind: .error)), .failed)
    XCTAssertNil(ChatHaptic.transition(from: turn(.done), to: turn(.done)))
  }
}

final class ChatSendWireTests: XCTestCase {
  private func object(_ data: Data) -> JSONObject? {
    try? JSONDecoder().decode(JSONValue.self, from: data).objectValue
  }

  func testRequestShapeForAnExistingSession() throws {
    let body = try ChatSendWire.body(for: ChatSendRequest(message: "Hello", target: .session("s1")))
    XCTAssertEqual(object(body), ["message": "Hello", "sessionId": "s1", "stream": true])
  }

  func testRequestShapeForANewConversation() throws {
    let body = try ChatSendWire.body(for: ChatSendRequest(message: "Hello", target: .newConversation))
    XCTAssertEqual(object(body), ["message": "Hello", "newConversation": true, "stream": true])
  }

  func testQueuedReceipt() throws {
    let receipt = try ChatSendWire.receipt(
      status: 200,
      body: Data(
        #"{"id":"q1","status":"queued","sessionId":"s1","message_received":true,"timestamp":"2026-11-02T00:00:00Z","model":"m","message":"Message queued","tracking_info":{"quest_id":"q1","check_status_url":"/api/quests/q1"}}"#
          .utf8))
    XCTAssertEqual(receipt, ChatSendReceipt(questID: "q1", sessionID: "s1", message: "Message queued"))
    XCTAssertFalse(receipt.isRefused)
  }

  func testRefusedReceiptCarriesTheErrorCode() throws {
    let receipt = try ChatSendWire.receipt(
      status: 200,
      body: Data(
        #"{"id":"q1","status":"queued","message_received":true,"timestamp":"t","model":"m","type":"error","errorCode":"insufficient_credits","message":"Not enough credits","tracking_info":{"quest_id":"q1","check_status_url":"/x"}}"#
          .utf8))
    XCTAssertTrue(receipt.isRefused)
    XCTAssertEqual(receipt.errorCode, .insufficientCredits)
  }

  func testErrorStatusesMapToAPIError() {
    XCTAssertThrowsError(try ChatSendWire.receipt(status: 429, body: Data())) { error in
      XCTAssertEqual(error as? APIError, .rateLimited)
    }
    XCTAssertThrowsError(try ChatSendWire.receipt(status: 200, body: Data("{}".utf8))) { error in
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testAPIClientPostsToChatWithBearer() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"id":"q9","sessionId":"s1"}"#.utf8)) }
    let client = APIClient(
      baseURL: URL(string: "https://api.example.test")!, tokens: FakeTokens([.success("jwt")]), transport: transport)

    let receipt = try await client.sendChatMessage(ChatSendRequest(message: "Hi", target: .session("s1")))

    XCTAssertEqual(receipt.questID, "q9")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/chat")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer jwt")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    XCTAssertEqual(object(try XCTUnwrap(request.httpBody)), ["message": "Hi", "sessionId": "s1", "stream": true])
  }

  func testAPIClientRetriesA401OnceThenSignsOut() async throws {
    let transport = FakeTransport { _ in (401, Data()) }
    let tokens = FakeTokens([.success("a"), .success("b")])
    let client = APIClient(baseURL: URL(string: "https://api.example.test")!, tokens: tokens, transport: transport)

    do {
      _ = try await client.sendChatMessage(ChatSendRequest(message: "Hi", target: .session("s1")))
      XCTFail("expected signedOut")
    } catch {
      XCTAssertEqual(error as? APIError, .signedOut)
    }
    let requests = await transport.requests
    XCTAssertEqual(requests.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer a", "Bearer b"])
    let rejections = await tokens.rejections
    XCTAssertEqual(rejections, 1)
  }

  func testAPIClientPollsAQuest() async throws {
    let transport = FakeTransport { _ in
      (
        200,
        Data(
          #"{"id":"q1","status":"done","type":"message","sessionId":"s1","reply":"Hi there","replies":[],"images":[],"videos":[],"files":[],"toolPayloads":[]}"#
            .utf8)
      )
    }
    let client = APIClient(
      baseURL: URL(string: "https://api.example.test")!, tokens: FakeTokens([.success("jwt")]), transport: transport)

    let quest = try await client.quest(id: "q1")

    XCTAssertEqual(quest.reply, "Hi there")
    XCTAssertEqual(quest.status, .done)
    let requests = await transport.requests
    XCTAssertEqual(requests.first?.url?.path(), "/api/v1/quests/q1")
  }
}

final class RealtimeHandshakeTests: XCTestCase {
  func testReadsTheWebsocketURLAndMintsTickets() async throws {
    let transport = FakeTransport { request in
      switch request.url?.path() {
      case "/api/settings/serverConfig":
        (200, Data(#"{"websocketUrl":"wss://ws.example.test/prod","cdnUrl":"x"}"#.utf8))
      case "/api/websocket/ticket":
        (201, Data(#"{"ticket":"abc123"}"#.utf8))
      default:
        (404, Data())
      }
    }
    let handshake = RealtimeHandshake(
      baseURL: URL(string: "https://api.example.test")!, tokens: FakeTokens([.success("jwt"), .success("jwt")]),
      transport: transport)

    let url = try await handshake.websocketURL()
    let ticket = try await handshake.mintTicket()

    XCTAssertEqual(url.absoluteString, "wss://ws.example.test/prod")
    XCTAssertEqual(url.appendingTicket(ticket).absoluteString, "wss://ws.example.test/prod?ticket=abc123")
    let ticketRequests = await transport.requests(to: "/api/websocket/ticket")
    let ticketRequest = try XCTUnwrap(ticketRequests.first)
    XCTAssertEqual(ticketRequest.httpMethod, "POST")
    XCTAssertEqual(ticketRequest.value(forHTTPHeaderField: "Authorization"), "Bearer jwt")
  }

  func testMissingWebsocketURLIsMalformed() async {
    let transport = FakeTransport { _ in (200, Data(#"{"cdnUrl":"x"}"#.utf8)) }
    let handshake = RealtimeHandshake(
      baseURL: URL(string: "https://api.example.test")!, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await handshake.websocketURL()
      XCTFail("expected malformedResponse")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }
}
