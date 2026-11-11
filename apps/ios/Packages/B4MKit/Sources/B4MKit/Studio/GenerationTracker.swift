import Foundation
import Observation

/// Remembers in-flight generations across launches.
public protocol GenerationStore: Sendable {
  func load() -> [GenerationHandle]
  func save(_ handles: [GenerationHandle])
}

public struct UserDefaultsGenerationStore: GenerationStore {
  private let key: String
  private let defaults: @Sendable () -> UserDefaults

  /// One store per server: ids from one deployment mean nothing to another.
  public init(environment: ServerEnvironment, defaults: @escaping @Sendable () -> UserDefaults = { .standard }) {
    key = "studio.inflightGenerations.\(environment.baseURL.absoluteString)"
    self.defaults = defaults
  }

  public func load() -> [GenerationHandle] {
    guard let data = defaults().data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([GenerationHandle].self, from: data)) ?? []
  }

  public func save(_ handles: [GenerationHandle]) {
    guard let data = try? JSONEncoder().encode(handles) else { return }
    defaults().set(data, forKey: key)
  }
}

/// One generation as Studio shows it: a placeholder tile while it runs, the outcome once it settles.
public struct TrackedGeneration: Identifiable, Equatable, Sendable {
  public let handle: GenerationHandle
  public internal(set) var phase: GenerationPhase
  public internal(set) var resultURLs: [URL]

  public var id: String { handle.id }
}

/// Follows every generation started from Studio until it settles.
///
/// Video and music jobs report through the realtime `generation_job_updated` frame; images have no job
/// frame, so they are polled through their quest. Every generation is also polled on a backoff, because
/// frames sent while the socket was down are never replayed. Polling stops at a terminal phase or after
/// `pollWindow`, so a job the server lost cannot poll forever.
@MainActor
@Observable
public final class GenerationTracker {
  public private(set) var generations: [TrackedGeneration] = []
  /// Bumps on every success, so a gallery can refresh when something new lands.
  public private(set) var succeededCount = 0

  public typealias Sleep = @Sendable (Duration) async throws -> Void

  /// Delays between polls; the last one repeats.
  static let pollDelays: [Duration] = [.seconds(2), .seconds(3), .seconds(5), .seconds(8), .seconds(15)]
  /// How long after it started a generation is still polled. Realtime frames still apply after that.
  static let pollWindow: TimeInterval = 30 * 60
  /// A stored generation older than this is dropped on relaunch instead of resumed.
  static let resumeWindow: TimeInterval = 24 * 60 * 60

  @ObservationIgnored private let api: any StudioAPI
  @ObservationIgnored private let realtime: (any RealtimeClient)?
  @ObservationIgnored private let store: any GenerationStore
  @ObservationIgnored private let sleep: Sleep
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let onSucceeded: @MainActor (TrackedGeneration) async -> Void
  @ObservationIgnored private var polls: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var listener: Task<Void, Never>?
  @ObservationIgnored private var resumed = false

  public init(
    api: any StudioAPI,
    realtime: (any RealtimeClient)?,
    store: any GenerationStore,
    sleep: @escaping Sleep = { try await Task.sleep(for: $0) },
    now: @escaping @Sendable () -> Date = Date.init,
    onSucceeded: @escaping @MainActor (TrackedGeneration) async -> Void = { _ in }
  ) {
    self.api = api
    self.realtime = realtime
    self.store = store
    self.sleep = sleep
    self.now = now
    self.onSucceeded = onSucceeded
  }

  public var inFlightCount: Int { generations.filter { !$0.phase.isTerminal }.count }

  /// Picks up generations from an earlier launch and starts listening for job frames. Idempotent.
  public func resume() {
    guard !resumed else { return }
    resumed = true
    startListening()
    let cutoff = now().addingTimeInterval(-Self.resumeWindow)
    for handle in store.load() where handle.startedAt > cutoff && !generations.contains(where: { $0.id == handle.id }) {
      track(handle)
    }
    persist()
  }

  /// Starts tracking a generation the server just accepted.
  public func track(_ handle: GenerationHandle) {
    guard !generations.contains(where: { $0.id == handle.id }) else { return }
    generations.insert(TrackedGeneration(handle: handle, phase: .queued, resultURLs: []), at: 0)
    persist()
    startPolling(handle)
  }

  public func cancel(_ id: String) async throws {
    guard let tracked = generations.first(where: { $0.id == id }), tracked.handle.isCancellable,
      !tracked.phase.isTerminal
    else { return }
    try await api.cancel(tracked.handle)
    apply(GenerationStatus(phase: .cancelled), to: id)
  }

  /// Removes a settled generation's tile.
  public func dismiss(_ id: String) {
    guard let index = generations.firstIndex(where: { $0.id == id }), generations[index].phase.isTerminal else {
      return
    }
    generations.remove(at: index)
  }

  /// Forgets everything, including what would resume on the next launch. For sign-out.
  public func reset() {
    stop()
    generations.removeAll()
    persist()
  }

  public func stop() {
    listener?.cancel()
    listener = nil
    polls.values.forEach { $0.cancel() }
    polls.removeAll()
    resumed = false
  }

  // MARK: - Updates

  func apply(_ status: GenerationStatus, to id: String) {
    guard let index = generations.firstIndex(where: { $0.id == id }) else { return }
    let current = generations[index]
    guard !current.phase.isTerminal else { return }
    generations[index].phase = status.phase
    if !status.resultURLs.isEmpty { generations[index].resultURLs = status.resultURLs }
    guard status.phase.isTerminal else { return }
    polls.removeValue(forKey: id)?.cancel()
    persist()
    if status.phase == .succeeded {
      succeededCount += 1
      let settled = generations[index]
      Task { await onSucceeded(settled) }
    }
  }

  private func forget(_ id: String) {
    polls.removeValue(forKey: id)?.cancel()
    generations.removeAll { $0.id == id }
    persist()
  }

  private func persist() {
    store.save(generations.filter { !$0.phase.isTerminal }.map(\.handle))
  }

  private func startListening() {
    guard listener == nil, let realtime else { return }
    listener = Task { [weak self] in
      for await event in await realtime.events() {
        guard let self else { return }
        switch event {
        case .frame(let frame):
          // Frames are per user, not per screen: anything not started from this tracker is ignored.
          guard let update = GenerationJobFrame(frame),
            let tracked = self.generations.first(where: { $0.id == update.jobID })
          else { continue }
          self.apply(update.status, to: update.jobID)
          if update.needsFetch { await self.pollOnce(tracked.handle) }
        case .refetchNeeded:
          // Frames sent while the socket was down are lost; poll everything still running once now.
          for tracked in self.generations where !tracked.phase.isTerminal { await self.pollOnce(tracked.handle) }
        default:
          continue
        }
      }
    }
  }

  private func startPolling(_ handle: GenerationHandle) {
    polls[handle.id]?.cancel()
    polls[handle.id] = Task { [weak self] in
      var attempt = 0
      while !Task.isCancelled {
        guard let self else { return }
        let delay = Self.pollDelays[min(attempt, Self.pollDelays.count - 1)]
        attempt += 1
        do { try await self.sleep(delay) } catch { return }
        guard self.now().timeIntervalSince(handle.startedAt) < Self.pollWindow else { return }
        guard await self.pollOnce(handle) else { return }
      }
    }
  }

  /// Fetches one status. Returns whether the generation is still running (so polling should continue).
  @discardableResult
  private func pollOnce(_ handle: GenerationHandle) async -> Bool {
    do {
      apply(try await api.status(of: handle), to: handle.id)
    } catch APIError.notFound {
      // Deleted, or started under another account on this device: nothing to show.
      forget(handle.id)
      return false
    } catch APIError.signedOut {
      return false
    } catch {
      // Offline or a server hiccup: keep polling on the backoff.
    }
    return generations.first(where: { $0.id == handle.id }).map { !$0.phase.isTerminal } ?? false
  }
}
