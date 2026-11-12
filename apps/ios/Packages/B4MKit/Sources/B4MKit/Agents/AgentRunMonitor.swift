import Foundation
import os

/// Follows started agent runs by polling `GET /api/v1/agent-executions/{id}` and feeds each poll to the
/// run's Live Activity.
///
/// REST-started runs have no realtime stream (the executor treats them as headless), so while the app is
/// open this is what keeps the lock screen current; the server's own pushes cover the rest of the time.
/// It outlives any screen: a run is fire-and-forget, so leaving the chat must not stop the watching.
public actor AgentRunMonitor {
  public struct Policy: Sendable {
    public var interval: Duration = .seconds(5)
    /// Hard stop per run (an hour at the default interval); a later launch no longer follows it.
    public var maxPolls = 720

    public init() {}
  }

  private let api: any AgentRunAPI
  private let tracker: any QuestActivityTracking
  private let policy: Policy
  private let sleep: @Sendable (Duration) async throws -> Void
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "agentrun")
  private var watching: [String: Task<Void, Never>] = [:]

  public init(
    api: any AgentRunAPI,
    tracker: any QuestActivityTracking,
    policy: Policy = Policy(),
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.api = api
    self.tracker = tracker
    self.policy = policy
    self.sleep = sleep
  }

  /// Starts following `executionID`, reporting under `trackingID` (the quest the activity is keyed by).
  public func watch(executionID: String, trackingID: String) {
    guard watching[executionID] == nil else { return }
    watching[executionID] = Task { [weak self] in
      await self?.poll(executionID: executionID, trackingID: trackingID)
      await self?.finishWatching(executionID)
    }
  }

  public func stopAll() {
    for task in watching.values { task.cancel() }
    watching.removeAll()
  }

  public var watchedExecutionIDs: [String] { Array(watching.keys) }

  private func finishWatching(_ executionID: String) {
    watching[executionID] = nil
  }

  private func poll(executionID: String, trackingID: String) async {
    var polls = 0
    while !Task.isCancelled, polls < policy.maxPolls {
      do {
        try await sleep(policy.interval)
      } catch {
        return
      }
      polls += 1
      do {
        let run = try await api.run(id: executionID)
        tracker.questChanged(questID: trackingID, to: QuestActivityMapping.state(from: run))
        if run.state.isTerminal { return }
      } catch let error as APIError where !error.isRetryable {
        logger.notice("Stopped following agent run: \(error, privacy: .public)")
        return
      } catch {
        continue
      }
    }
  }
}

/// Starts an agent run for a session. Screens depend on this, not on the API and monitor behind it.
public protocol AgentRunStarting: Sendable {
  func startRun(sessionID: String, title: String, message: String) async throws -> AgentRunReceipt
}

/// The fire-and-forget run: start it over REST, give it a Live Activity, and keep that activity current.
public struct AgentRunService: AgentRunStarting {
  public static let startingLabel = "Starting agent"

  private let api: any AgentRunAPI
  private let tracker: any QuestActivityTracking
  private let monitor: AgentRunMonitor
  private let now: @Sendable () -> Date

  public init(
    api: any AgentRunAPI, tracker: any QuestActivityTracking, monitor: AgentRunMonitor,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.api = api
    self.tracker = tracker
    self.monitor = monitor
    self.now = now
  }

  public func startRun(sessionID: String, title: String, message: String) async throws -> AgentRunReceipt {
    let receipt = try await api.startRun(sessionID: sessionID, message: message)
    tracker.questStarted(
      QuestActivityStart(
        questID: receipt.trackingID, sessionID: receipt.sessionID, title: title, startedAt: now(),
        initialState: QuestActivityContentState(phase: .running, stageLabel: Self.startingLabel)))
    await monitor.watch(executionID: receipt.executionID, trackingID: receipt.trackingID)
    return receipt
  }
}
