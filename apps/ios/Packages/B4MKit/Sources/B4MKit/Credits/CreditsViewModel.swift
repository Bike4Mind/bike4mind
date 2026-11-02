import Foundation
import Observation

@MainActor
@Observable
public final class CreditsViewModel {
  public private(set) var balance: CreditBalance?
  public private(set) var state: ListLoadState = .idle

  @ObservationIgnored private let api: any B4MAPI
  @ObservationIgnored private let onBalance: (@Sendable (CreditBalance) async -> Void)?

  /// - Parameter onBalance: told about every successfully fetched balance (the app feeds the Credits widget).
  public init(api: any B4MAPI, onBalance: (@Sendable (CreditBalance) async -> Void)? = nil) {
    self.api = api
    self.onBalance = onBalance
  }

  public func load() async {
    if balance == nil { state = .loading }
    do {
      let fetched = try await api.creditBalance()
      balance = fetched
      state = .loaded
      await onBalance?(fetched)
    } catch {
      state = .failed((error as? APIError) ?? .malformedResponse)
    }
  }

  /// Whole credits with grouping ("31,667"); fractions are noise at this scale.
  public static func formatted(_ credits: Double, locale: Locale = .current) -> String {
    CreditsFormat.whole(credits, locale: locale)
  }
}
