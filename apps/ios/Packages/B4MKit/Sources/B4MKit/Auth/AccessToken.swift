import Foundation

/// A bearer JWT held in memory only, with the expiry read from its `exp` claim.
struct AccessToken: Sendable, Equatable {
  /// Refresh this early so a token never expires between being handed out and reaching the server.
  static let expiryLeeway: TimeInterval = 60
  /// Server access tokens live 30 minutes; assume slightly less when `exp` is unreadable.
  static let fallbackLifetime: TimeInterval = 25 * 60

  let value: String
  let expiresAt: Date

  init(value: String, issuedAt: Date) {
    self.value = value
    self.expiresAt = Self.expiry(ofJWT: value) ?? issuedAt.addingTimeInterval(Self.fallbackLifetime)
  }

  func isUsable(at date: Date) -> Bool {
    date.addingTimeInterval(Self.expiryLeeway) < expiresAt
  }

  static func expiry(ofJWT jwt: String) -> Date? {
    let segments = jwt.split(separator: ".")
    guard segments.count == 3,
      let payload = Base64URL.decode(String(segments[1])),
      let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      let exp = claims["exp"] as? NSNumber
    else {
      return nil
    }
    return Date(timeIntervalSince1970: exp.doubleValue)
  }
}
