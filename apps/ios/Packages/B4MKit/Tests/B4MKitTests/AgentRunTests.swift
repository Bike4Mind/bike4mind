import XCTest

@testable import B4MKit

final class AgentRunWireTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  func testStartSendsOnlyTheSessionAndMessageToTheContractRoute() async throws {
    let transport = FakeTransport { _ in
      (
        202,
        Data(
          #"{"id":"e1","status":"pending","session_id":"s1","tracking_info":{"execution_id":"e1","quest_id":"q9","poll_url":"/x"}}"#
            .utf8)
      )
    }
    let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let receipt = try await client.startRun(sessionID: "s1", message: "Audit this")

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/agent-executions")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    XCTAssertEqual(
      String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self), #"{"message":"Audit this","session_id":"s1"}"#)
    XCTAssertEqual(receipt, AgentRunReceipt(executionID: "e1", questID: "q9", sessionID: "s1"))
    XCTAssertEqual(receipt.trackingID, "q9")
  }

  func testAReceiptWithoutAQuestIsTrackedByItsExecution() async throws {
    let transport = FakeTransport { _ in
      (
        202,
        Data(
          #"{"id":"e1","status":"pending","session_id":"s1","tracking_info":{"execution_id":"e1","poll_url":"/x"}}"#
            .utf8)
      )
    }
    let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let receipt = try await client.startRun(sessionID: "s1", message: "go")
    XCTAssertNil(receipt.questID)
    XCTAssertEqual(receipt.trackingID, "e1")
  }

  func testStartFailuresMapToAPIErrors() async {
    for (status, expected) in [
      (404, APIError.notFound), (409, .server(status: 409)), (429, .rateLimited), (502, .server(status: 502)),
    ] {
      let transport = FakeTransport { _ in (status, Data()) }
      let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: transport)
      do {
        _ = try await client.startRun(sessionID: "s1", message: "go")
        XCTFail("expected \(status) to fail")
      } catch {
        XCTAssertEqual(error as? APIError, expected, "\(status)")
      }
    }
  }

  func testAnUnreadableAckIsMalformed() async {
    let client = AgentRunClient(
      baseURL: base, tokens: FakeTokens(), transport: FakeTransport { _ in (202, Data("nope".utf8)) })
    do {
      _ = try await client.startRun(sessionID: "s1", message: "go")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testPollingReadsStatusAndTheToolTrace() async throws {
    let body = """
      {"id":"e1","status":"awaiting_permission","session_id":"s1","answer":null,"error":null,
       "steps":[{"type":"thought","content":"x","iteration":0},
                {"type":"action","content":"y","iteration":0,"tool_name":"web_search"},
                {"type":"mystery","content":"z"}],
       "total_iterations":1,"created_at":"a","updated_at":"b"}
      """
    let transport = FakeTransport { _ in (200, Data(body.utf8)) }
    let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let run = try await client.run(id: "e1")

    let requests = await transport.requests
    XCTAssertEqual(requests.first?.httpMethod, "GET")
    XCTAssertEqual(requests.first?.url?.path(), "/api/v1/agent-executions/e1")
    XCTAssertEqual(run.state, .awaitingPermission)
    XCTAssertEqual(
      run.steps,
      [
        AgentRunStatus.Step(type: .thought), AgentRunStatus.Step(type: .action, toolName: "web_search"),
        AgentRunStatus.Step(type: .other),
      ])
  }

  func testAnUnknownRunStatusDecodesAsRunning() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"id":"e1","status":"brand_new","steps":[]}"#.utf8)) }
    let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let run = try await client.run(id: "e1")
    XCTAssertEqual(run.state, .running)
  }

  func testAFailedRunCarriesItsReason() async throws {
    let transport = FakeTransport { _ in
      (200, Data(#"{"id":"e1","status":"failed","error":"Tool needs approval: web_browse","steps":[]}"#.utf8))
    }
    let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let run = try await client.run(id: "e1")
    XCTAssertEqual(run.error, "Tool needs approval: web_browse")
    XCTAssertTrue(run.state.isTerminal)
  }

  func testExecutionIDsThatCouldEscapeThePathAreRefused() async {
    let client = AgentRunClient(baseURL: base, tokens: FakeTokens(), transport: FakeTransport { _ in (200, Data()) })
    do {
      _ = try await client.run(id: "../admin")
      XCTFail("expected refusal")
    } catch {
      XCTAssertEqual(error as? APIError, .notFound)
    }
  }
}

final class AgentRunMonitorTests: XCTestCase {
  private func run(_ state: AgentRunStatus.State, steps: [AgentRunStatus.Step] = []) -> Result<AgentRunStatus, APIError>
  {
    .success(AgentRunStatus(id: "exec-1", state: state, steps: steps))
  }

  private func makeMonitor(
    _ api: FakeAgentRunAPI, tracker: RecordingTracker, maxPolls: Int = 720
  ) -> AgentRunMonitor {
    var policy = AgentRunMonitor.Policy()
    policy.maxPolls = maxPolls
    return AgentRunMonitor(api: api, tracker: tracker, policy: policy, sleep: { _ in await Task.yield() })
  }

  func testPollsReportEachStateAndStopAtTheTerminalOne() async {
    let api = FakeAgentRunAPI()
    await api.setRunResults([
      run(.running, steps: [AgentRunStatus.Step(type: .action, toolName: "web_search")]),
      run(.awaitingPermission),
      run(.completed),
    ])
    let tracker = RecordingTracker()
    let monitor = makeMonitor(api, tracker: tracker)

    await monitor.watch(executionID: "exec-1", trackingID: "quest-1")
    await waitUntil("the run to be reported done") { tracker.changes.count == 3 }
    await waitUntil("the monitor to stop") { await monitor.watchedExecutionIDs.isEmpty }

    XCTAssertEqual(tracker.changes.map(\.questID), ["quest-1", "quest-1", "quest-1"])
    XCTAssertEqual(tracker.changes.map(\.state.phase), [.running, .approvalNeeded, .completed])
    XCTAssertEqual(tracker.changes.first?.state.stageLabel, "Using web_search")
    let polled = await api.polled
    XCTAssertEqual(polled.count, 3, "no polling past the terminal state")
  }

  func testATransientErrorKeepsPollingButARefusalStops() async {
    let api = FakeAgentRunAPI()
    await api.setRunResults([.failure(.offline), run(.completed)])
    let tracker = RecordingTracker()
    let monitor = makeMonitor(api, tracker: tracker)
    await monitor.watch(executionID: "exec-1", trackingID: "quest-1")
    await waitUntil("recovery") { tracker.changes.map(\.state.phase) == [.completed] }

    let gone = FakeAgentRunAPI()
    await gone.setRunResults([.failure(.notFound)])
    let goneTracker = RecordingTracker()
    let goneMonitor = makeMonitor(gone, tracker: goneTracker)
    await goneMonitor.watch(executionID: "exec-1", trackingID: "quest-1")
    await waitUntil("the monitor to give up") { await goneMonitor.watchedExecutionIDs.isEmpty }
    XCTAssertTrue(goneTracker.changes.isEmpty)
    let polled = await gone.polled
    XCTAssertEqual(polled.count, 1)
  }

  func testPollingIsBounded() async {
    let api = FakeAgentRunAPI()
    await api.setRunResults([run(.running)])
    let tracker = RecordingTracker()
    let monitor = makeMonitor(api, tracker: tracker, maxPolls: 4)
    await monitor.watch(executionID: "exec-1", trackingID: "quest-1")
    await waitUntil("the monitor to stop") { await monitor.watchedExecutionIDs.isEmpty }
    let polled = await api.polled
    XCTAssertEqual(polled.count, 4)
  }

  func testStopAllCancelsEveryWatcher() async {
    let api = FakeAgentRunAPI()
    await api.setRunResults([run(.running)])
    let tracker = RecordingTracker()
    let monitor = AgentRunMonitor(api: api, tracker: tracker, sleep: { _ in try await Task.sleep(for: .seconds(60)) })
    await monitor.watch(executionID: "exec-1", trackingID: "quest-1")
    await monitor.stopAll()
    let watched = await monitor.watchedExecutionIDs
    XCTAssertTrue(watched.isEmpty)
  }
}

final class AgentRunServiceTests: XCTestCase {
  func testStartingARunStartsItsActivityBeforeWatchingIt() async throws {
    let api = FakeAgentRunAPI()
    await api.setRunResults([.success(AgentRunStatus(id: "exec-1", state: .completed))])
    let tracker = RecordingTracker()
    let monitor = AgentRunMonitor(api: api, tracker: tracker, sleep: { _ in await Task.yield() })
    let clock = TestClock()
    let service = AgentRunService(api: api, tracker: tracker, monitor: monitor, now: { clock.now })

    let receipt = try await service.startRun(sessionID: "s1", title: "Quarterly review", message: "Audit this")

    let started = await api.started
    XCTAssertEqual(started.map(\.sessionID), ["s1"])
    XCTAssertEqual(started.map(\.message), ["Audit this"])
    XCTAssertEqual(receipt.questID, "quest-run-1")
    await waitUntil("the poll to be reported") { tracker.calls.count == 2 }
    XCTAssertEqual(
      tracker.calls.first,
      .started(
        QuestActivityStart(
          questID: "quest-run-1", sessionID: "s1", title: "Quarterly review", startedAt: clock.now,
          initialState: QuestActivityContentState(phase: .running, stageLabel: "Starting agent"))))
    XCTAssertEqual(tracker.changes.map(\.questID), ["quest-run-1"])
  }

  func testARunTheServerRefusesStartsNoActivity() async {
    let api = FakeAgentRunAPI()
    await api.setStartResult(.failure(.server(status: 409)))
    let tracker = RecordingTracker()
    let monitor = AgentRunMonitor(api: api, tracker: tracker)
    let service = AgentRunService(api: api, tracker: tracker, monitor: monitor)
    do {
      _ = try await service.startRun(sessionID: "s1", title: "t", message: "go")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? APIError, .server(status: 409))
    }
    XCTAssertTrue(tracker.calls.isEmpty)
  }
}

final class LiveActivityPushTokenWireTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  func testALiveActivityTokenCarriesKindActivityAndQuest() async throws {
    let transport = FakeTransport { _ in (204, Data()) }
    let client = PushTokenClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.registerLiveActivityToken(
      "abc123", activityID: "act-1", questID: "quest-9", environment: .production, appVersion: "0.1.0")

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/push-tokens")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(
      json as NSDictionary,
      [
        "token": "abc123", "kind": "liveActivity", "platform": "ios", "environment": "production",
        "activityId": "act-1", "questId": "quest-9", "appVersion": "0.1.0",
      ] as NSDictionary)
  }

  func testTheDeviceRegistrationBodyIsUnchangedAndCarriesNoActivityFields() async throws {
    let transport = FakeTransport { _ in (204, Data()) }
    let client = PushTokenClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    try await client.registerPushToken("abc", environment: .sandbox, appVersion: nil)
    let requests = await transport.requests
    let json = try XCTUnwrap(
      JSONSerialization.jsonObject(with: XCTUnwrap(requests.first?.httpBody)) as? [String: Any])
    XCTAssertEqual(
      json as NSDictionary,
      ["token": "abc", "kind": "device", "platform": "ios", "environment": "sandbox"] as NSDictionary)
  }
}
