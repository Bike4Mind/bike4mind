import Foundation
import XCTest

@testable import B4MKit

/// A Live Activity as ActivityKit would hand it back, recording what the manager does to it.
final class FakeActivityHandle: LiveActivityHandle, @unchecked Sendable {
  struct Update: Equatable {
    let state: QuestActivityContentState
    let staleDate: Date?
  }

  struct End: Equatable {
    let state: QuestActivityContentState
    let dismissal: LiveActivityDismissal
  }

  let activityID: String
  let attributes: QuestActivityAttributes
  let pushTokenUpdates: AsyncStream<Data>
  let lifecycleUpdates: AsyncStream<LiveActivityLifecycle>
  private let tokenContinuation: AsyncStream<Data>.Continuation
  private let lifecycleContinuation: AsyncStream<LiveActivityLifecycle>.Continuation
  private let lock = NSLock()
  private var recordedUpdates: [Update] = []
  private var recordedEnds: [End] = []

  init(activityID: String, attributes: QuestActivityAttributes) {
    self.activityID = activityID
    self.attributes = attributes
    (pushTokenUpdates, tokenContinuation) = AsyncStream<Data>.makeStream()
    (lifecycleUpdates, lifecycleContinuation) = AsyncStream<LiveActivityLifecycle>.makeStream()
  }

  var updates: [Update] { lock.withLock { recordedUpdates } }
  var ends: [End] { lock.withLock { recordedEnds } }

  func emitToken(_ bytes: [UInt8]) { tokenContinuation.yield(Data(bytes)) }
  func emitLifecycle(_ state: LiveActivityLifecycle) { lifecycleContinuation.yield(state) }

  func update(_ state: QuestActivityContentState, staleDate: Date?) async {
    lock.withLock { recordedUpdates.append(Update(state: state, staleDate: staleDate)) }
  }

  func end(_ state: QuestActivityContentState, dismissal: LiveActivityDismissal) async {
    lock.withLock { recordedEnds.append(End(state: state, dismissal: dismissal)) }
  }
}

final class FakeLiveActivityHost: LiveActivityHosting, @unchecked Sendable {
  private let lock = NSLock()
  private var enabled = true
  private var started: [FakeActivityHandle] = []
  private var survivors: [FakeActivityHandle] = []
  private var failure: (any Error)?
  private var counter = 0
  private var firstToken: [UInt8]?

  struct StartFailure: Error {}

  var areActivitiesEnabled: Bool { lock.withLock { enabled } }
  var handles: [FakeActivityHandle] { lock.withLock { started } }

  func setEnabled(_ value: Bool) { lock.withLock { enabled = value } }
  func failStarts() { lock.withLock { failure = StartFailure() } }
  /// ActivityKit issues a push token right after an activity starts; this models that.
  func issueTokenOnStart(_ bytes: [UInt8]) { lock.withLock { firstToken = bytes } }

  func addSurvivor(questID: String, sessionID: String = "s1") -> FakeActivityHandle {
    lock.withLock {
      counter += 1
      let handle = FakeActivityHandle(
        activityID: "survivor-\(counter)",
        attributes: QuestActivityAttributes(
          questId: questID, sessionId: sessionID, title: "Earlier", startedAt: Date(timeIntervalSince1970: 0)))
      survivors.append(handle)
      return handle
    }
  }

  func start(
    attributes: QuestActivityAttributes, state: QuestActivityContentState, staleDate: Date?
  ) async throws -> any LiveActivityHandle {
    try lock.withLock {
      if let failure { throw failure }
      counter += 1
      let handle = FakeActivityHandle(activityID: "activity-\(counter)", attributes: attributes)
      started.append(handle)
      if let firstToken { handle.emitToken(firstToken) }
      return handle
    }
  }

  func existing() -> [any LiveActivityHandle] { lock.withLock { survivors } }
}

/// Records what the chat and run code report, in order.
final class RecordingTracker: QuestActivityTracking, @unchecked Sendable {
  enum Call: Equatable {
    case started(QuestActivityStart)
    case changed(String, QuestActivityContentState)
  }

  private let lock = NSLock()
  private var recorded: [Call] = []

  var calls: [Call] { lock.withLock { recorded } }
  var starts: [QuestActivityStart] {
    calls.compactMap {
      if case .started(let start) = $0 { start } else { nil }
    }
  }
  var changes: [(questID: String, state: QuestActivityContentState)] {
    calls.compactMap {
      if case .changed(let id, let state) = $0 { (id, state) } else { nil }
    }
  }

  func questStarted(_ quest: QuestActivityStart) { lock.withLock { recorded.append(.started(quest)) } }
  func questChanged(questID: String, to state: QuestActivityContentState) {
    lock.withLock { recorded.append(.changed(questID, state)) }
  }
}

/// Scripted `AgentRunAPI`: `run(id:)` serves the queued results in order and repeats the last one.
actor FakeAgentRunAPI: AgentRunAPI {
  var startResult: Result<AgentRunReceipt, APIError> = .success(
    AgentRunReceipt(executionID: "exec-1", questID: "quest-run-1", sessionID: "s1"))
  var runResults: [Result<AgentRunStatus, APIError>] = []
  private(set) var started: [(sessionID: String, message: String)] = []
  private(set) var polled: [String] = []

  func setStartResult(_ result: Result<AgentRunReceipt, APIError>) { startResult = result }
  func setRunResults(_ results: [Result<AgentRunStatus, APIError>]) { runResults = results }

  func startRun(sessionID: String, message: String) async throws -> AgentRunReceipt {
    started.append((sessionID, message))
    return try startResult.get()
  }

  func run(id: String) async throws -> AgentRunStatus {
    polled.append(id)
    guard !runResults.isEmpty else { throw APIError.notFound }
    let next = runResults.count > 1 ? runResults.removeFirst() : runResults[0]
    return try next.get()
  }
}

actor FakeAgentRunStarter: AgentRunStarting {
  var result: Result<AgentRunReceipt, APIError> = .success(
    AgentRunReceipt(executionID: "exec-1", questID: "quest-run-1", sessionID: "s1"))
  private(set) var requests: [(sessionID: String, title: String, message: String)] = []

  func setResult(_ result: Result<AgentRunReceipt, APIError>) { self.result = result }

  func startRun(sessionID: String, title: String, message: String) async throws -> AgentRunReceipt {
    requests.append((sessionID, title, message))
    return try result.get()
  }
}

/// Polls `condition` until it holds, for effects that run in unstructured tasks.
func waitUntil(
  timeout: Duration = .seconds(3), _ message: String = "condition", file: StaticString = #filePath, line: UInt = #line,
  _ condition: @escaping @Sendable () async -> Bool
) async {
  let deadline = ContinuousClock.now.advanced(by: timeout)
  while ContinuousClock.now < deadline {
    if await condition() { return }
    try? await Task.sleep(for: .milliseconds(5))
  }
  XCTFail("Timed out waiting for \(message)", file: file, line: line)
}
