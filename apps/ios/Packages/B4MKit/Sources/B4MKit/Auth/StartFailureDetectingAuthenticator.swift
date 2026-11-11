import Foundation

/// Tells a sheet that never showed apart from a user who dismissed it. When the system refuses to start
/// the web-auth session (for example a build without the `webcredentials:` associated domain, such as an
/// unsigned simulator build), it reports a plain cancel within a few hundred milliseconds, so the sign-in
/// screen would otherwise stay silent. Nobody can see the sheet and tap Cancel that fast.
@MainActor
public struct StartFailureDetectingAuthenticator: WebAuthenticating {
  /// Faster than any cancel a person could make: the sheet alone takes about half a second to appear.
  public static let minimumUserCancelInterval: TimeInterval = 1

  private let base: any WebAuthenticating
  private let now: () -> Date

  public init(_ base: any WebAuthenticating, now: @escaping () -> Date = Date.init) {
    self.base = base
    self.now = now
  }

  public func authenticate(url: URL, callbackURL: URL) async throws -> URL {
    let start = now()
    do {
      return try await base.authenticate(url: url, callbackURL: callbackURL)
    } catch AuthError.cancelled where now().timeIntervalSince(start) < Self.minimumUserCancelInterval {
      throw AuthError.webSessionFailedToStart
    }
  }
}
