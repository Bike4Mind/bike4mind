import Foundation
import Observation

@MainActor
@Observable
public final class CreditsViewModel {
  public private(set) var balance: CreditBalance?
  public private(set) var state: ListLoadState = .idle

  @ObservationIgnored private let fetch: @MainActor () async throws -> CreditBalance
  @ObservationIgnored private let onBalance: (@Sendable (CreditBalance) async -> Void)?
  @ObservationIgnored private let now: () -> Date
  @ObservationIgnored private let ttl: TimeInterval
  @ObservationIgnored private var fetchedAt: Date?
  @ObservationIgnored private var inFlight: Task<Void, Never>?
  @ObservationIgnored private var generation = 0

  /// - Parameter onBalance: told about every successfully fetched balance (the app feeds the Credits widget).
  public init(
    ttl: TimeInterval = 30, now: @escaping () -> Date = Date.init,
    fetch: @escaping @MainActor () async throws -> CreditBalance,
    onBalance: (@Sendable (CreditBalance) async -> Void)? = nil
  ) {
    self.ttl = ttl
    self.now = now
    self.fetch = fetch
    self.onBalance = onBalance
  }

  public func load(force: Bool = false) async {
    if !force {
      if let inFlight {
        await inFlight.value
        return
      }
      if let fetchedAt, now().timeIntervalSince(fetchedAt) < ttl { return }
    }
    // A settled turn must not reuse a request started before its spend completed.
    inFlight?.cancel()
    generation += 1
    let requestGeneration = generation
    if balance == nil { state = .loading }
    let task = Task {
      do {
        let fetched = try await fetch()
        guard generation == requestGeneration else { return }
        balance = fetched
        fetchedAt = now()
        state = .loaded
        await onBalance?(fetched)
      } catch {
        guard generation == requestGeneration else { return }
        state = .failed((error as? APIError) ?? .malformedResponse)
      }
    }
    inFlight = task
    await task.value
    if generation == requestGeneration { inFlight = nil }
  }

  public func invalidate() {
    generation += 1
    inFlight?.cancel()
    inFlight = nil
    fetchedAt = nil
    balance = nil
    state = .idle
  }

  /// Whole credits with grouping ("31,667"); fractions are noise at this scale.
  public static func formatted(_ credits: Double, locale: Locale = .current) -> String {
    CreditsFormat.whole(credits, locale: locale)
  }
}
