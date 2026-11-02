import XCTest

@testable import B4MKit

final class WSClientTests: XCTestCase {
  private var clock: TestClock!
  private var handshake: FakeHandshake!
  private var connector: FakeConnector!
  private var sleeper: RecordingSleeper!
  private var client: WSClient?

  override func setUp() async throws {
    clock = TestClock()
    handshake = FakeHandshake()
    connector = FakeConnector()
    sleeper = RecordingSleeper()
  }

  override func tearDown() async throws {
    await client?.stop()
    client = nil
  }

  private func makeClient(
    maxAttempts: Int = 20,
    rotations: (@Sendable () async -> AsyncStream<String>)? = nil
  ) -> WSClient {
    let client = WSClient(
      handshake: handshake, connector: connector,
      backoff: ReconnectBackoff(maxAttempts: maxAttempts, jitter: { 0 }),
      tokenRotations: rotations, now: clock.provider, sleep: sleeper.sleep)
    self.client = client
    return client
  }

  /// Starts the client and waits for its first socket.
  private func connected(_ client: WSClient) async throws -> FakeSocket {
    await client.start()
    await eventually { [connector] in connector!.all.count == 1 }
    await eventually { await client.connectionState == .connected }
    return try XCTUnwrap(connector.latest)
  }

  /// Collects every event from now on.
  private func record(_ client: WSClient) async -> Locked<[RealtimeEvent]> {
    let box = Locked<[RealtimeEvent]>([])
    let events = await client.events()
    Task {
      for await event in events { box.mutate { $0.append(event) } }
    }
    return box
  }

  private static func ticket(of socket: FakeSocket) -> String? {
    URLComponents(url: socket.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "ticket" }?.value
  }

  // MARK: - Handshake

  func testEachConnectMintsAFreshTicket() async throws {
    let client = makeClient()
    let first = try await connected(client)
    XCTAssertEqual(first.url.host(), "ws.example.test")
    XCTAssertEqual(Self.ticket(of: first), "ticket-1")

    first.serverClose()
    await eventually { [connector] in connector!.all.count == 2 }

    let second = try XCTUnwrap(connector.latest)
    XCTAssertEqual(Self.ticket(of: second), "ticket-2", "a ticket is single-use: every reconnect mints a new one")
    let minted = await handshake.mintedTickets
    XCTAssertEqual(minted, ["ticket-1", "ticket-2"])
    let lookups = await handshake.urlLookups
    XCTAssertEqual(lookups, 1, "the endpoint is looked up once and reused while connects succeed")
  }

  func testSignedOutHandshakeStopsWithoutRetrying() async throws {
    await handshake.setTicketFailure(.signedOut)
    let client = makeClient()
    await client.start()

    await eventually { await client.connectionState == .idle }
    let minted = await handshake.mintedTickets
    XCTAssertTrue(minted.isEmpty)
    XCTAssertTrue(connector.all.isEmpty)
  }

  // MARK: - Heartbeat

  func testHeartbeatIsSentEveryFifteenSeconds() async throws {
    sleeper = RecordingSleeper(suspending: [])
    let client = makeClient()
    let socket = try await connected(client)

    await eventually { socket.sentActions("heartbeat").count >= 2 }
    XCTAssertEqual(socket.sentActions("heartbeat").first, ["action": "heartbeat"])
    let heartbeatSleeps = sleeper.durations.filter { $0 == .seconds(15) }
    XCTAssertGreaterThanOrEqual(heartbeatSleeps.count, 2)
    XCTAssertTrue(sleeper.durations.allSatisfy { $0 == .seconds(15) }, "only the heartbeat sleeps while connected")
  }

  func testSilenceForSixtySecondsClosesAndReconnects() async throws {
    let client = makeClient()
    let socket = try await connected(client)

    clock.advance(by: 59)
    let aliveAt59 = await client.heartbeatTick()
    XCTAssertTrue(aliveAt59)
    XCTAssertFalse(socket.isClosed)
    XCTAssertEqual(socket.sentActions("heartbeat").count, 1)

    clock.advance(by: 1)
    let aliveAt60 = await client.heartbeatTick()
    XCTAssertFalse(aliveAt60)
    XCTAssertTrue(socket.isClosed, "60s without any frame means the socket is dead")
    await eventually { [connector] in connector!.all.count == 2 }
  }

  func testBareTextPongCountsAsLiveness() async throws {
    let client = makeClient()
    let socket = try await connected(client)

    clock.advance(by: 50)
    socket.push("pong")
    let pongTime = clock.now
    await eventually { await client.lastReceivedAt == pongTime }

    clock.advance(by: 50)
    let alive = await client.heartbeatTick()
    XCTAssertTrue(alive, "100s since connect but only 50s since the pong")
    XCTAssertFalse(socket.isClosed)
  }

  func testEmptyAndNonJSONFramesAreIgnored() async throws {
    let client = makeClient()
    let socket = try await connected(client)
    let events = await record(client)

    for junk in ["", "   ", "not json", "[1,2,3]", "42", "{\"no\":\"action\"}", "{\"action\":17}"] {
      socket.push(junk)
    }
    socket.push(["action": "marker"] as JSONValue)

    await eventually { events.current.contains(.frame(ActionFrame(action: "marker", payload: ["action": "marker"]))) }
    let frames = events.current.filter { if case .frame = $0 { true } else { false } }
    XCTAssertEqual(frames.count, 1, "nothing but the marker reaches consumers")
    XCTAssertFalse(socket.isClosed)
  }

  // MARK: - Reconnect

  func testReconnectResubscribesAndRequestsRefetch() async throws {
    let client = makeClient()
    let early = await client.subscribe(
      SubscriptionRequest(
        subscriptionID: "sub-early", collectionName: "quests", query: ["sessionId": "s1"], fields: ["reply": true],
        fetchInitialData: true))
    let first = try await connected(client)
    let events = await record(client)
    let late = await client.subscribe(
      SubscriptionRequest(
        subscriptionID: "sub-late", collectionName: "sessions", query: [:], fields: ["name": true],
        fetchInitialData: false))

    let firstIDs = Set(first.sentActions("subscribe_query").compactMap { $0["subscriptionId"]?.stringValue })
    XCTAssertEqual(firstIDs, ["sub-early", "sub-late"])
    XCTAssertFalse(events.current.contains(.refetchNeeded), "the first connect is not a reconnect")

    first.serverClose()
    await eventually { [connector] in connector!.all.count == 2 }
    let second = try XCTUnwrap(connector.latest)

    await eventually { second.sentActions("subscribe_query").count == 2 }
    let resent = Dictionary(
      uniqueKeysWithValues: second.sentActions("subscribe_query").map { ($0["subscriptionId"]!.stringValue!, $0) })
    XCTAssertEqual(
      resent["sub-early"],
      [
        "action": "subscribe_query", "subscriptionId": "sub-early", "collectionName": "quests",
        "query": ["sessionId": "s1"], "fields": ["reply": true], "fetchInitialData": true,
      ])
    XCTAssertEqual(resent["sub-late"]?["fetchInitialData"], false)
    await eventually { events.current.filter { $0 == .refetchNeeded }.count == 1 }
    XCTAssertTrue(sleeper.durations.contains(.milliseconds(125)), "first retry waits 125ms (+ jitter)")
    withExtendedLifetime((early, late)) {}
  }

  func testExhaustedAttemptsSuspendUntilResumed() async throws {
    connector.failNext(100)
    let client = makeClient(maxAttempts: 3)
    await client.start()

    await eventually { await client.connectionState == .suspended }
    let attemptsBeforeResume = await handshake.mintedTickets.count
    XCTAssertEqual(attemptsBeforeResume, 4, "the initial try plus three retries")

    connector.failNext(0)
    await client.resume()
    await eventually { await client.connectionState == .connected }
  }

  // MARK: - Token rotation

  func testRotationSendsReauthThenResubscribesOnRequest() async throws {
    let (rotations, rotate) = AsyncStream<String>.makeStream()
    let client = makeClient(rotations: { rotations })
    let socket = try await connected(client)
    // Holding the stream keeps the subscription: dropping it unsubscribes.
    let updates = await client.subscribe(collection: "quests", query: ["sessionId": "s1"], fields: ["reply": true])
    await eventually { socket.sentActions("subscribe_query").count == 1 }

    rotate.yield("jwt-2")
    await eventually { socket.sentActions("reauth_connection").count == 1 }
    XCTAssertEqual(
      socket.sentActions("reauth_connection").first, ["action": "reauth_connection", "accessToken": "jwt-2"])
    XCTAssertEqual(socket.sentActions("subscribe_query").count, 1, "nothing is re-sent until the server asks")

    socket.push(["action": "resubscribe_required"] as JSONValue)
    await eventually { socket.sentActions("subscribe_query").count == 2 }
    XCTAssertFalse(socket.isClosed)
    XCTAssertEqual(connector.all.count, 1, "reauth keeps the same socket")
    withExtendedLifetime(updates) {}
  }

  // MARK: - Subscriptions

  func testDataUpdatesReachTheirSubscription() async throws {
    let client = makeClient()
    let socket = try await connected(client)
    let events = await record(client)
    let updates = await client.subscribe(
      SubscriptionRequest(
        subscriptionID: "sub-1", collectionName: "quests", query: [:], fields: [:], fetchInitialData: true))

    socket.push(
      [
        "action": "data_update", "subscriptionId": "someone-else", "collectionName": "quests",
        "operationType": "update", "data": ["_id": "x", "id": "x"],
      ] as JSONValue)
    socket.push(
      [
        "action": "data_update", "subscriptionId": "sub-1", "collectionName": "quests",
        "operationType": "insert", "data": ["_id": "q1", "id": "q1", "reply": "hi"],
      ] as JSONValue)
    socket.push(["action": "data_subscribe_error", "subscriptionId": "sub-1", "error": "bad query"] as JSONValue)

    var iterator = updates.makeAsyncIterator()
    let update = await iterator.next()
    XCTAssertEqual(update?.documentID, "q1")
    XCTAssertEqual(update?.operationType, "insert")
    XCTAssertEqual(update?.data["reply"], "hi")
    await eventually { events.current.contains(.subscriptionFailed(subscriptionID: "sub-1", message: "bad query")) }
  }

  func testEndingTheStreamUnsubscribes() async throws {
    let client = makeClient()
    let socket = try await connected(client)
    let updates = await client.subscribe(
      SubscriptionRequest(
        subscriptionID: "sub-1", collectionName: "quests", query: [:], fields: [:], fetchInitialData: false))

    let consumer = Task { for await _ in updates {} }
    consumer.cancel()

    await eventually { socket.sentActions("unsubscribe_query").count == 1 }
    XCTAssertEqual(
      socket.sentActions("unsubscribe_query").first, ["action": "unsubscribe_query", "subscriptionId": "sub-1"])
  }

  // MARK: - Routing

  func testUnknownActionsAreForwardedAndNeverFatal() async throws {
    let client = makeClient()
    let socket = try await connected(client)
    let events = await record(client)

    socket.push(["action": "agent_text_delta", "executionId": "e1", "iteration": 1, "delta": "x"] as JSONValue)
    socket.push(["action": "something_from_the_future", "payload": [1, 2]] as JSONValue)
    socket.push(["action": "iteration_step", "step": ["kind": "tool"]] as JSONValue)

    await eventually {
      events.current.filter { if case .frame = $0 { true } else { false } }.count == 3
    }
    XCTAssertFalse(socket.isClosed)
    let state = await client.connectionState
    XCTAssertEqual(state, .connected)
  }

  func testChunkedFrameIsReassembledBeforeRouting() async throws {
    let client = makeClient()
    let socket = try await connected(client)
    let events = await record(client)

    let original: JSONValue = [
      "action": "streamed_chat_completion",
      "quest": ["id": "q1", "sessionId": "s1", "reply": "a long reply \u{1F600} with emoji", "status": "running"],
      "statusMessage": "",
    ]
    let text = original.encodedString()
    let pieces = stride(from: 0, to: text.count, by: 20).map { start -> String in
      let from = text.index(text.startIndex, offsetBy: start)
      let to = text.index(from, offsetBy: min(20, text.count - start))
      return String(text[from..<to])
    }
    // Out of order on purpose.
    for index in pieces.indices.reversed() {
      socket.push(
        [
          "_chunked": true, "_chunkId": "c1", "_chunkIndex": .number(Double(index)),
          "_totalChunks": .number(Double(pieces.count)), "_data": .string(pieces[index]),
        ] as JSONValue)
    }

    await eventually {
      events.current.contains(.frame(ActionFrame(action: "streamed_chat_completion", payload: original.objectValue!)))
    }
  }

  /// Review Focus 4: a chunked frame missing a piece is dropped after its TTL, never rendered as garbage,
  /// and the next (cumulative) frame flows normally.
  func testMissingChunkIsDroppedAndTheStreamHeals() async throws {
    let client = makeClient()
    let socket = try await connected(client)
    let events = await record(client)

    let lost = #"{"action":"streamed_chat_completion","quest":{"id":"q1","sessionId":"s1","reply":"Hel"}}"#
    let third = lost.count / 3
    let parts = [
      String(lost.prefix(third)), String(lost.dropFirst(third).prefix(third)), String(lost.dropFirst(2 * third)),
    ]
    for index in [0, 2] {
      socket.push(
        [
          "_chunked": true, "_chunkId": "lost", "_chunkIndex": .number(Double(index)), "_totalChunks": 3,
          "_data": .string(parts[index]),
        ] as JSONValue)
    }

    await eventually { await client.pendingChunkCount == 1 }
    clock.advance(by: 31)
    _ = await client.heartbeatTick()  // purges the expired partial even without further chunks
    // The straggler arrives after the TTL: it must not complete the dropped partial.
    socket.push(
      [
        "_chunked": true, "_chunkId": "lost", "_chunkIndex": 1, "_totalChunks": 3, "_data": .string(parts[1]),
      ] as JSONValue)
    socket.push(
      [
        "action": "streamed_chat_completion",
        "quest": ["id": "q1", "sessionId": "s1", "reply": "Hello world", "status": "running"],
      ] as JSONValue)

    await eventually { events.current.contains { if case .frame = $0 { true } else { false } } }
    let frames = events.current.compactMap { event -> ActionFrame? in
      if case .frame(let frame) = event { frame } else { nil }
    }
    XCTAssertEqual(frames.count, 1)
    XCTAssertEqual(frames.first?.payload["quest"]?["reply"], "Hello world")
    XCTAssertFalse(socket.isClosed, "a lost chunk never takes the connection down")
  }
}

final class ReconnectBackoffTests: XCTestCase {
  func testScheduleMatchesTheWebClient() {
    let none = ReconnectBackoff(maxAttempts: 20, jitter: { 0 })
    XCTAssertEqual(none.delay(forAttempt: 0), .milliseconds(125))
    XCTAssertEqual(none.delay(forAttempt: 1), .milliseconds(500))
    XCTAssertEqual(none.delay(forAttempt: 2), .milliseconds(1125))
    XCTAssertEqual(none.delay(forAttempt: 19), .milliseconds(50_000))
    XCTAssertNil(none.delay(forAttempt: 20), "attempts are capped")

    let full = ReconnectBackoff(maxAttempts: 20, jitter: { 1 })
    XCTAssertEqual(full.delay(forAttempt: 0), .milliseconds(1125), "jitter adds up to one second")
  }
}
