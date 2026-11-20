import Foundation
import os

/// What it takes to start a quest's Live Activity.
public struct QuestActivityStart: Sendable, Equatable {
  public let questID: String
  public let sessionID: String
  public let title: String
  public let startedAt: Date
  public let initialState: QuestActivityContentState

  public init(
    questID: String, sessionID: String, title: String, startedAt: Date,
    initialState: QuestActivityContentState = QuestActivityContentState(phase: .running)
  ) {
    self.questID = questID
    self.sessionID = sessionID
    self.title = title
    self.startedAt = startedAt
    self.initialState = initialState
  }
}

/// The seam the chat and agent-run code report quest progress through. The calls are synchronous and
/// ordered: an implementation takes them in the order they were made, so a view model on the main actor
/// can call it without spawning tasks that might reorder a start and the update that follows it.
public protocol QuestActivityTracking: Sendable {
  /// A quest began. Starts its activity (at most one per quest) unless activities are off or the session is over.
  func questStarted(_ quest: QuestActivityStart)
  /// The quest moved. A terminal state ends the activity; calls for a quest without an activity are ignored.
  func questChanged(questID: String, to state: QuestActivityContentState)
}

public typealias PushTokenAPIProvider = @MainActor @Sendable () -> any PushTokenAPI

/// Owns every Live Activity the app has running, one per quest.
///
/// **Starts.** `questStarted` (a chat send the server accepted, or an agent run the app started) begins an
/// activity with `pushType: .token`. Its push token is registered with the server (`kind: liveActivity`,
/// the quest id) the moment ActivityKit issues it, before anything else is done for the activity, because
/// the server drops frames sent before registration.
///
/// **Updates.** Two sources feed one activity: the server's pushes (rate limited to one per 15 seconds,
/// delivered by the system straight to the activity) and local calls to `questChanged`, mapped from the
/// realtime frames the chat already receives (`QuestActivityMapping`). The local source keeps a foreground
/// activity fresher than the push throttle, and makes the feature work where remote activity pushes are
/// unavailable (the simulator). Identical states are dropped, and same-phase updates are spaced by
/// `Policy.minimumUpdateInterval` (a streaming reply sends many frames).
///
/// **Ends.** A terminal state ends the activity and leaves it on the lock screen for a while
/// (`Policy.dismissAfter`). A remote `end` that wins the race is harmless: ending an ended activity is a
/// no-op, and the manager drops the activity when the system reports it ended. A finished quest is
/// remembered, so a straggling frame cannot start a second activity for it.
///
/// **Limits.** At most `Policy.maxConcurrent` activities; a new quest past that ends the oldest one
/// immediately (newest wins). With activities disabled in Settings, everything no-ops.
///
/// **Session.** Nothing starts before `sessionDidStart()`. `sessionWillEnd()` (user sign-out, before the
/// session is torn down) ends every activity and unregisters their tokens; `sessionDidEnd()` is the same
/// without the server calls, for a session that ended on its own.
public actor QuestActivityManager: QuestActivityTracking {
  public struct Policy: Sendable {
    public var maxConcurrent = 5
    /// An activity nobody updated for this long is marked stale (the system dims it).
    public var staleAfter: TimeInterval = 15 * 60
    public var minimumUpdateInterval: TimeInterval = 1
    public var completedDismissAfter: TimeInterval = 5 * 60
    public var stoppedDismissAfter: TimeInterval = 5 * 60
    /// Failures stay longest: the user may be away and should still see that a run broke.
    public var failedDismissAfter: TimeInterval = 15 * 60
    public var tokenRetryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(10)]
    public var signOutUnregisterTimeout: Duration = .seconds(3)

    public init() {}

    func dismissAfter(_ phase: QuestRunPhase) -> TimeInterval {
      switch phase {
      case .failed: failedDismissAfter
      case .stopped: stoppedDismissAfter
      case .completed, .running, .paused, .approvalNeeded: completedDismissAfter
      }
    }
  }

  private struct Tracked {
    let handle: any LiveActivityHandle
    var state: QuestActivityContentState
    var lastUpdateAt: Date
    var pushToken: String?
    var tasks: [Task<Void, Never>]
  }

  private enum Command: Sendable {
    case sessionStarted
    case start(QuestActivityStart)
    case change(questID: String, state: QuestActivityContentState)
    case tokenRegistered(questID: String, activityID: String, token: String)
    case hostEnded(questID: String, activityID: String)
    case endAll(unregister: Bool, completion: CheckedContinuation<Void, Never>?)
    case barrier(CheckedContinuation<Void, Never>)
  }

  private let host: any LiveActivityHosting
  private let registrar: LiveActivityTokenRegistrar
  private let policy: Policy
  private let now: @Sendable () -> Date
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "liveactivity")
  private nonisolated let commands: AsyncStream<Command>.Continuation

  private var isSessionActive = false
  private var tracked: [String: Tracked] = [:]
  /// Quest ids in start order, oldest first.
  private var startOrder: [String] = []
  private var finishedQuests: [String] = []
  private var finishedSet: Set<String> = []
  private static let finishedMemory = 64

  public init(
    host: any LiveActivityHosting,
    makeTokenAPI: @escaping PushTokenAPIProvider,
    environment: PushEnvironment = .forThisBuild,
    appVersion: String? = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
    policy: Policy = Policy(),
    now: @escaping @Sendable () -> Date = Date.init,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.host = host
    self.policy = policy
    self.now = now
    registrar = LiveActivityTokenRegistrar(
      makeAPI: makeTokenAPI, environment: environment, appVersion: appVersion, retryDelays: policy.tokenRetryDelays,
      sleep: sleep)
    let (stream, continuation) = AsyncStream<Command>.makeStream()
    commands = continuation
    Task { [weak self] in
      for await command in stream {
        guard let self else { return }
        await self.handle(command)
      }
    }
  }

  deinit {
    commands.finish()
  }

  // MARK: - QuestActivityTracking

  public nonisolated func questStarted(_ quest: QuestActivityStart) {
    commands.yield(.start(quest))
  }

  public nonisolated func questChanged(questID: String, to state: QuestActivityContentState) {
    commands.yield(.change(questID: questID, state: state))
  }

  // MARK: - Session

  /// Call when a session becomes active. Re-attaches to activities that survived a relaunch, so their
  /// push tokens are registered again and sign-out can end them.
  public nonisolated func sessionDidStart() {
    commands.yield(.sessionStarted)
  }

  /// Ends every activity and unregisters their push tokens. Call before a user-initiated sign-out tears
  /// the session down; the unregister calls need it. Gives up on the server after the policy timeout.
  public nonisolated func sessionWillEnd() async {
    await withCheckedContinuation { commands.yield(.endAll(unregister: true, completion: $0)) }
  }

  /// Ends every activity without calling the server. For a session that ended without our involvement.
  public nonisolated func sessionDidEnd() {
    commands.yield(.endAll(unregister: false, completion: nil))
  }

  /// Returns once every command given so far has been handled.
  public nonisolated func waitUntilIdle() async {
    await withCheckedContinuation { commands.yield(.barrier($0)) }
  }

  public var activeQuestIDs: [String] { startOrder }

  // MARK: - Command handling

  private func handle(_ command: Command) async {
    switch command {
    case .sessionStarted:
      isSessionActive = true
      await adoptExistingActivities()
    case .start(let quest):
      await start(quest)
    case .change(let questID, let state):
      await change(questID: questID, to: state)
    case .tokenRegistered(let questID, let activityID, let token):
      await tokenRegistered(questID: questID, activityID: activityID, token: token)
    case .hostEnded(let questID, let activityID):
      hostEnded(questID: questID, activityID: activityID)
    case .endAll(let unregister, let completion):
      await endAll(unregister: unregister)
      completion?.resume()
    case .barrier(let continuation):
      continuation.resume()
    }
  }

  private func start(_ quest: QuestActivityStart) async {
    guard isSessionActive else { return }
    guard tracked[quest.questID] == nil, !finishedSet.contains(quest.questID) else { return }
    guard !quest.initialState.phase.isTerminal else { return }
    guard host.areActivitiesEnabled else {
      logger.notice("Live Activities are off; not starting one")
      return
    }
    if tracked.count >= policy.maxConcurrent, let oldest = startOrder.first {
      await finish(questID: oldest, with: tracked[oldest]?.state, dismissal: .immediate)
    }

    let attributes = QuestActivityAttributes(
      questId: quest.questID, sessionId: quest.sessionID, title: quest.title, startedAt: quest.startedAt)
    let handle: any LiveActivityHandle
    do {
      handle = try await host.start(
        attributes: attributes, state: quest.initialState, staleDate: staleDate())
    } catch {
      logger.error("Could not start a Live Activity: \(error, privacy: .public)")
      return
    }
    track(handle, questID: quest.questID, state: quest.initialState)
  }

  private func adoptExistingActivities() async {
    for handle in host.existing() {
      let questID = handle.attributes.questId
      guard tracked[questID] == nil, !finishedSet.contains(questID) else { continue }
      if tracked.count >= policy.maxConcurrent {
        await handle.end(QuestActivityContentState(phase: .stopped), dismissal: .immediate)
        continue
      }
      track(handle, questID: questID, state: QuestActivityContentState(phase: .running))
    }
  }

  private func track(_ handle: any LiveActivityHandle, questID: String, state: QuestActivityContentState) {
    tracked[questID] = Tracked(
      handle: handle, state: state, lastUpdateAt: .distantPast, pushToken: nil,
      tasks: observe(handle, questID: questID))
    startOrder.append(questID)
  }

  private func change(questID: String, to incoming: QuestActivityContentState) async {
    guard var entry = tracked[questID] else { return }
    let merged = Self.merge(previous: entry.state, incoming: incoming)
    if incoming.phase.isTerminal {
      await finish(questID: questID, with: merged, dismissal: nil)
      return
    }
    guard merged != entry.state else { return }
    let current = now()
    if merged.phase == entry.state.phase, current.timeIntervalSince(entry.lastUpdateAt) < policy.minimumUpdateInterval {
      return
    }
    entry.state = merged
    entry.lastUpdateAt = current
    tracked[questID] = entry
    await entry.handle.update(merged, staleDate: staleDate())
  }

  /// A frame without a label keeps the stage the user was already shown while the quest is still running.
  static func merge(
    previous: QuestActivityContentState, incoming: QuestActivityContentState
  ) -> QuestActivityContentState {
    guard !incoming.phase.isTerminal else { return incoming }
    var merged = incoming
    if merged.stageLabel == nil, incoming.phase == .running, previous.phase == .running {
      merged.stageLabel = previous.stageLabel
    }
    merged.progress = incoming.progress ?? previous.progress
    return merged
  }

  /// Ends and forgets a quest's activity. `state` is what stays on the lock screen; `dismissal` defaults to
  /// the policy's linger time for that state.
  private func finish(
    questID: String, with state: QuestActivityContentState?, dismissal: LiveActivityDismissal?, unregister: Bool = true
  ) async {
    guard let entry = tracked.removeValue(forKey: questID) else { return }
    startOrder.removeAll { $0 == questID }
    remember(finished: questID)
    for task in entry.tasks { task.cancel() }

    let finalState = state ?? entry.state
    let policyDismissal = dismissal ?? .after(now().addingTimeInterval(policy.dismissAfter(finalState.phase)))
    await entry.handle.end(finalState, dismissal: policyDismissal)

    if unregister, let token = entry.pushToken {
      let registrar = registrar
      Task { await registrar.unregister(token: token) }
    }
  }

  private func tokenRegistered(questID: String, activityID: String, token: String) async {
    guard var entry = tracked[questID], entry.handle.activityID == activityID else {
      // The activity ended while its registration was in flight: do not leave a token behind.
      let registrar = registrar
      Task { await registrar.unregister(token: token) }
      return
    }
    entry.pushToken = token
    tracked[questID] = entry
  }

  private func hostEnded(questID: String, activityID: String) {
    guard let entry = tracked[questID], entry.handle.activityID == activityID else { return }
    tracked[questID] = nil
    startOrder.removeAll { $0 == questID }
    remember(finished: questID)
    for task in entry.tasks { task.cancel() }
  }

  private func endAll(unregister: Bool) async {
    isSessionActive = false
    let questIDs = startOrder
    var tokens: [String] = []
    for questID in questIDs {
      if let token = tracked[questID]?.pushToken { tokens.append(token) }
      await finish(
        questID: questID, with: QuestActivityContentState(phase: .stopped), dismissal: .immediate, unregister: false)
    }
    guard unregister, !tokens.isEmpty else { return }
    await registrar.unregisterAll(tokens, timeout: policy.signOutUnregisterTimeout)
  }

  private func remember(finished questID: String) {
    guard finishedSet.insert(questID).inserted else { return }
    finishedQuests.append(questID)
    if finishedQuests.count > Self.finishedMemory {
      finishedSet.remove(finishedQuests.removeFirst())
    }
  }

  private func staleDate() -> Date {
    now().addingTimeInterval(policy.staleAfter)
  }

  /// Watches one activity: registers its push token (and every rotation) and notices the system ending it.
  private func observe(_ handle: any LiveActivityHandle, questID: String) -> [Task<Void, Never>] {
    let commands = commands
    let registrar = registrar
    let activityID = handle.activityID
    let tokens = Task {
      for await data in handle.pushTokenUpdates {
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard await registrar.register(token: token, activityID: activityID, questID: questID) else { continue }
        commands.yield(.tokenRegistered(questID: questID, activityID: activityID, token: token))
      }
    }
    let lifecycle = Task {
      for await state in handle.lifecycleUpdates where state == .ended || state == .dismissed {
        commands.yield(.hostEnded(questID: questID, activityID: activityID))
        return
      }
    }
    return [tokens, lifecycle]
  }
}

/// Registers live activity push tokens, retrying while the server is unreachable: a token the server never
/// hears about means a lock screen that only moves while the app is open.
struct LiveActivityTokenRegistrar: Sendable {
  let makeAPI: PushTokenAPIProvider
  let environment: PushEnvironment
  let appVersion: String?
  let retryDelays: [Duration]
  let sleep: @Sendable (Duration) async throws -> Void
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "liveactivity")

  init(
    makeAPI: @escaping PushTokenAPIProvider, environment: PushEnvironment, appVersion: String?,
    retryDelays: [Duration], sleep: @escaping @Sendable (Duration) async throws -> Void
  ) {
    self.makeAPI = makeAPI
    self.environment = environment
    self.appVersion = appVersion
    self.retryDelays = retryDelays
    self.sleep = sleep
  }

  func register(token: String, activityID: String, questID: String) async -> Bool {
    var delays = retryDelays[...]
    while true {
      do {
        try await makeAPI().registerLiveActivityToken(
          token, activityID: activityID, questID: questID, environment: environment, appVersion: appVersion)
        return true
      } catch {
        if let apiError = error as? APIError, !apiError.isRetryable {
          logger.error("Live activity token registration refused: \(error, privacy: .public)")
          return false
        }
        guard let delay = delays.popFirst(), !Task.isCancelled else {
          logger.error("Live activity token registration failed: \(error, privacy: .public)")
          return false
        }
        do {
          try await sleep(delay)
        } catch {
          return false
        }
      }
    }
  }

  func unregister(token: String) async {
    do {
      try await makeAPI().unregisterPushToken(token)
    } catch {
      logger.notice("Live activity token unregister failed (best effort): \(error, privacy: .public)")
    }
  }

  func unregisterAll(_ tokens: [String], timeout: Duration) async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask {
        await withTaskGroup(of: Void.self) { inner in
          for token in tokens { inner.addTask { await unregister(token: token) } }
        }
      }
      group.addTask { try? await Task.sleep(for: timeout) }
      await group.next()
      group.cancelAll()
    }
  }
}
