import Foundation
import Observation

@MainActor
@Observable
public final class CreditsViewModel {
  public private(set) var balance: CreditBalance?
  public private(set) var state: ListLoadState = .idle

  @ObservationIgnored private let api: any B4MAPI

  public init(api: any B4MAPI) {
    self.api = api
  }

  public func load() async {
    if balance == nil { state = .loading }
    do {
      balance = try await api.creditBalance()
      state = .loaded
    } catch {
      state = .failed((error as? APIError) ?? .malformedResponse)
    }
  }

  /// Whole credits with grouping ("31,667"); fractions are noise at this scale.
  public static func formatted(_ credits: Double, locale: Locale = .current) -> String {
    credits.formatted(.number.precision(.fractionLength(0)).locale(locale))
  }
}
