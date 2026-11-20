import Foundation

#if os(iOS)
  import ActivityKit
#endif

/// What the system does to an activity without the app asking (a remote `end` push, the user swiping it away).
public enum LiveActivityLifecycle: Sendable, Equatable {
  case active
  case stale
  case ended
  case dismissed
}

public enum LiveActivityDismissal: Sendable, Equatable {
  case immediate
  /// Stays on the lock screen, in its final state, until then.
  case after(Date)
}

/// One running Live Activity, in app terms. `ActivityKitHost` wraps ActivityKit's `Activity`; tests and
/// previews substitute a fake, because ActivityKit cannot run on the macOS test host.
public protocol LiveActivityHandle: Sendable {
  var activityID: String { get }
  var attributes: QuestActivityAttributes { get }
  /// The activity's APNs push token, and every rotation of it. The first value arrives right after the
  /// activity starts.
  var pushTokenUpdates: AsyncStream<Data> { get }
  var lifecycleUpdates: AsyncStream<LiveActivityLifecycle> { get }
  func update(_ state: QuestActivityContentState, staleDate: Date?) async
  /// Ending an activity that already ended is a no-op, so a local end racing a remote one is harmless.
  func end(_ state: QuestActivityContentState, dismissal: LiveActivityDismissal) async
}

public protocol LiveActivityHosting: Sendable {
  /// Whether the user allows Live Activities for the app (Settings > Bike4Mind > Live Activities).
  var areActivitiesEnabled: Bool { get }
  /// Starts an activity that accepts remote updates (`pushType: .token`).
  func start(
    attributes: QuestActivityAttributes, state: QuestActivityContentState, staleDate: Date?
  ) async throws -> any LiveActivityHandle
  /// Activities still alive from an earlier launch of the app.
  func existing() -> [any LiveActivityHandle]
}

#if os(iOS)
  public struct ActivityKitHost: LiveActivityHosting {
    public init() {}

    public var areActivitiesEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    public func start(
      attributes: QuestActivityAttributes, state: QuestActivityContentState, staleDate: Date?
    ) async throws -> any LiveActivityHandle {
      let activity = try Activity<QuestActivityAttributes>.request(
        attributes: attributes, content: ActivityContent(state: state, staleDate: staleDate), pushType: .token)
      return ActivityKitHandle(activity: activity)
    }

    public func existing() -> [any LiveActivityHandle] {
      Activity<QuestActivityAttributes>.activities.map { ActivityKitHandle(activity: $0) }
    }
  }

  // Activity is not annotated Sendable by the SDK but is documented thread-safe.
  struct ActivityKitHandle: LiveActivityHandle, @unchecked Sendable {
    let activity: Activity<QuestActivityAttributes>

    var activityID: String { activity.id }
    var attributes: QuestActivityAttributes { activity.attributes }

    var pushTokenUpdates: AsyncStream<Data> {
      let handle = self
      return AsyncStream { continuation in
        let task = Task {
          for await token in handle.activity.pushTokenUpdates { continuation.yield(token) }
          continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
      }
    }

    var lifecycleUpdates: AsyncStream<LiveActivityLifecycle> {
      let handle = self
      return AsyncStream { continuation in
        let task = Task {
          for await state in handle.activity.activityStateUpdates {
            switch state {
            case .active, .pending: continuation.yield(.active)
            case .stale: continuation.yield(.stale)
            case .ended: continuation.yield(.ended)
            case .dismissed: continuation.yield(.dismissed)
            @unknown default: continuation.yield(.active)
            }
          }
          continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
      }
    }

    func update(_ state: QuestActivityContentState, staleDate: Date?) async {
      await activity.update(ActivityContent(state: state, staleDate: staleDate))
    }

    func end(_ state: QuestActivityContentState, dismissal: LiveActivityDismissal) async {
      let policy: ActivityUIDismissalPolicy =
        switch dismissal {
        case .immediate: .immediate
        case .after(let date): .after(date)
        }
      await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: policy)
    }
  }
#endif
