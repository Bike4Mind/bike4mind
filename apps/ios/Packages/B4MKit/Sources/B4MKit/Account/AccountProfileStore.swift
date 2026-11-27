import Foundation
import Observation

/// The signed-in account's profile, kept for the session so the drawer, Settings and the new-conversation header
/// render it on their first frame instead of a placeholder. Stale-while-revalidate: `profile(in:)` reads the stored
/// value synchronously, and `refresh()` updates it in the background, at most once per `maxAge` unless forced.
///
/// The stored value belongs to one (user, server) pair. A refresh that resolves a different pair drops the old
/// value before anything is rendered from it, and `invalidate()` (the auth-state transition) drops it outright, so
/// one account's name and email never show for another.
@MainActor
@Observable
public final class AccountProfileStore {
  /// Whose profile this is: the account on a given server.
  public struct Scope: Hashable, Sendable {
    public let userID: String
    public let environment: ServerEnvironment

    public init(userID: String, environment: ServerEnvironment) {
      self.userID = userID
      self.environment = environment
    }
  }

  /// A profile that is younger than this is not refetched on re-entry; it changes rarely.
  public static let defaultMaxAge: TimeInterval = 5 * 60

  private var stored: AccountProfile?
  // Observed: a view that rendered before any profile was stored must be told when one lands.
  private var storedScope: Scope?
  @ObservationIgnored private var storedAt: Date?
  @ObservationIgnored private var inFlight: (id: Int, scope: Scope, task: Task<Void, Never>)?
  @ObservationIgnored private var nextFetchID = 0
  // Bumped by `invalidate()` so a fetch that was already running cannot repopulate the cleared store.
  @ObservationIgnored private var generation = 0

  @ObservationIgnored private let resolveScope: @MainActor () async -> Scope?
  @ObservationIgnored private let fetch: @Sendable (Scope) async -> AccountProfile?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let maxAge: TimeInterval

  /// - Parameters:
  ///   - resolveScope: the current user and server, or `nil` when nobody is signed in.
  ///   - fetch: loads the profile from the server; `nil` on failure (the stored value is kept then).
  public init(
    maxAge: TimeInterval = AccountProfileStore.defaultMaxAge,
    now: @escaping @Sendable () -> Date = { Date() },
    resolveScope: @escaping @MainActor () async -> Scope?,
    fetch: @escaping @Sendable (Scope) async -> AccountProfile?
  ) {
    self.maxAge = maxAge
    self.now = now
    self.resolveScope = resolveScope
    self.fetch = fetch
  }

  /// The stored profile when it was loaded from `environment`, else `nil`. Reads are synchronous so a view can
  /// draw it on its first frame; the environment check keeps a server switch from showing the old server's account.
  public func profile(in environment: ServerEnvironment) -> AccountProfile? {
    guard storedScope?.environment == environment else { return nil }
    return stored
  }

  /// Loads the profile unless a fresh one is stored. Concurrent callers for the same account share one request.
  public func refresh(force: Bool = false) async {
    // No scope can be a transient token-refresh failure; the session ending clears the store via `invalidate()`.
    guard let scope = await resolveScope() else { return }
    if storedScope != scope {
      stored = nil
      storedAt = nil
      storedScope = scope
    }
    if !force, stored != nil, let storedAt, now().timeIntervalSince(storedAt) < maxAge { return }
    if let inFlight, inFlight.scope == scope {
      await inFlight.task.value
      return
    }
    let startedIn = generation
    let fetch = self.fetch
    nextFetchID += 1
    let id = nextFetchID
    let task = Task { @MainActor [weak self] in
      let loaded = await fetch(scope)
      guard let self, self.generation == startedIn else { return }
      if self.inFlight?.id == id { self.inFlight = nil }
      // A refresh for another account may have replaced this one while it ran; its result is not ours to keep.
      guard self.storedScope == scope else { return }
      guard let loaded else { return }
      self.stored = loaded
      self.storedAt = self.now()
    }
    inFlight = (id, scope, task)
    await task.value
  }

  /// Forgets the profile and abandons any fetch still running. Called when the session ends.
  public func invalidate() {
    generation += 1
    inFlight?.task.cancel()
    inFlight = nil
    stored = nil
    storedScope = nil
    storedAt = nil
  }
}
