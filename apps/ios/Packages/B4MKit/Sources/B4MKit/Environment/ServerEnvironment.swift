import Foundation

/// Which Bike4Mind deployment the app talks to. Release builds are always `.production`;
/// `.custom` exists for the DEBUG server picker (staging, preview stages, a local stack).
///
/// Named `ServerEnvironment` rather than `Environment` so it never collides with SwiftUI's
/// `@Environment` in files that import both modules.
public enum ServerEnvironment: Hashable, Sendable, Codable {
  case production
  case custom(URL)

  public static let productionBaseURL = URL(string: "https://app.bike4mind.com")!

  /// Maps the production origin to `.production` so it gets the first-party client; anything else is `.custom`.
  public init(url: URL) {
    let production = Self.productionBaseURL
    let isProduction =
      url.scheme?.lowercased() == "https"
      && url.host()?.lowercased() == production.host()?.lowercased()
      && (url.port == nil || url.port == 443)
      && (url.path.isEmpty || url.path == "/")
    self = isProduction ? .production : .custom(url)
  }

  public var baseURL: URL {
    switch self {
    case .production: Self.productionBaseURL
    case .custom(let url): url
    }
  }

  public var displayName: String {
    switch self {
    case .production: "Production"
    case .custom(let url): url.host() ?? url.absoluteString
    }
  }
}

/// Persists the DEBUG server-picker choice across launches.
public struct ServerEnvironmentStore: Sendable {
  private static let key = "b4m.serverEnvironment"
  private let suiteName: String?

  /// - Parameter suiteName: a `UserDefaults` suite; `nil` means `.standard`.
  public init(suiteName: String? = nil) {
    self.suiteName = suiteName
  }

  private var defaults: UserDefaults {
    suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
  }

  public func load() -> ServerEnvironment {
    guard let data = defaults.data(forKey: Self.key),
      let environment = try? JSONDecoder().decode(ServerEnvironment.self, from: data)
    else {
      return .production
    }
    return environment
  }

  public func save(_ environment: ServerEnvironment) {
    // Encoding a two-case enum of URL cannot fail.
    let data = try? JSONEncoder().encode(environment)
    defaults.set(data, forKey: Self.key)
  }
}
