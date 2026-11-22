import Foundation
import Observation

/// The Studio model lists (image, video, music), kept for the session so the create bar renders its models on its
/// first frame instead of refetching them whenever Studio is opened. Stale-while-revalidate: `models(for:)` reads
/// synchronously, and `refresh(_:)` loads in the background, at most once per `maxAge` per kind unless forced.
///
/// The lists the server returns depend on the caller (the account's admitted models), so the stored value belongs
/// to one (user, server) pair: a refresh that resolves a different pair drops the old lists, and `invalidate()`
/// (the auth-state transition) drops them outright.
@MainActor
@Observable
public final class StudioModelCatalog {
  /// Whose lists these are: the account on a given server.
  public struct Scope: Hashable, Sendable {
    public let userID: String
    public let environment: ServerEnvironment

    public init(userID: String, environment: ServerEnvironment) {
      self.userID = userID
      self.environment = environment
    }
  }

  /// A model list changes with a deployment or a plan change, not within a sitting.
  public static let defaultMaxAge: TimeInterval = 10 * 60

  private struct Entry {
    let models: [GenerationModel]
    let loadedAt: Date
  }

  // Observed: a bar that rendered before any list was stored must be told when one lands.
  private var entries: [GenerationKind: Entry] = [:]
  private var storedScope: Scope?
  @ObservationIgnored private var inFlight: [GenerationKind: (id: Int, scope: Scope, task: Task<Void, Never>)] = [:]
  @ObservationIgnored private var nextFetchID = 0
  // Bumped by `invalidate()` so a fetch that was already running cannot repopulate the cleared store.
  @ObservationIgnored private var generation = 0

  @ObservationIgnored private let currentEnvironment: @MainActor () -> ServerEnvironment
  @ObservationIgnored private let resolveUserID: @MainActor () async -> String?
  @ObservationIgnored private let fetch: @MainActor (GenerationKind) async throws -> [GenerationModel]
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let maxAge: TimeInterval

  /// - Parameters:
  ///   - currentEnvironment: the server the app points at now.
  ///   - resolveUserID: the signed-in user, or `nil` when nobody is.
  ///   - fetch: loads one kind's list from the current server. A throw or an empty list stores nothing.
  public init(
    maxAge: TimeInterval = StudioModelCatalog.defaultMaxAge,
    now: @escaping @Sendable () -> Date = { Date() },
    currentEnvironment: @escaping @MainActor () -> ServerEnvironment,
    resolveUserID: @escaping @MainActor () async -> String?,
    fetch: @escaping @MainActor (GenerationKind) async throws -> [GenerationModel]
  ) {
    self.maxAge = maxAge
    self.now = now
    self.currentEnvironment = currentEnvironment
    self.resolveUserID = resolveUserID
    self.fetch = fetch
  }

  /// The stored list when it was loaded from the current server, else `nil`. Synchronous so a view can draw it on
  /// its first frame; the environment check keeps a server switch from showing the old server's models.
  public func models(for kind: GenerationKind) -> [GenerationModel]? {
    guard storedScope?.environment == currentEnvironment() else { return nil }
    return entries[kind]?.models
  }

  /// Loads the kind's list unless a fresh one is stored. Concurrent callers share one request. A failed load keeps
  /// whatever is stored, so a stale list still beats none; callers fall back when `models(for:)` stays `nil`.
  public func refresh(_ kind: GenerationKind, force: Bool = false) async {
    // No user can be a transient token-refresh failure; the session ending clears the store via `invalidate()`.
    guard let userID = await resolveUserID() else { return }
    let scope = Scope(userID: userID, environment: currentEnvironment())
    if storedScope != scope {
      entries = [:]
      storedScope = scope
    }
    if !force, let entry = entries[kind], now().timeIntervalSince(entry.loadedAt) < maxAge { return }
    if let running = inFlight[kind], running.scope == scope {
      await running.task.value
      return
    }
    let startedIn = generation
    let fetch = self.fetch
    nextFetchID += 1
    let id = nextFetchID
    let task = Task { @MainActor [weak self] in
      let loaded = try? await fetch(kind)
      guard let self, self.generation == startedIn else { return }
      if self.inFlight[kind]?.id == id { self.inFlight[kind] = nil }
      // A refresh for another account or server may have replaced this one while it ran.
      guard self.storedScope == scope, let loaded, !loaded.isEmpty else { return }
      self.entries[kind] = Entry(models: loaded, loadedAt: self.now())
    }
    inFlight[kind] = (id, scope, task)
    await task.value
  }

  /// Forgets every list and abandons any fetch still running. Called when the session ends.
  public func invalidate() {
    generation += 1
    inFlight.values.forEach { $0.task.cancel() }
    inFlight = [:]
    entries = [:]
    storedScope = nil
  }
}
