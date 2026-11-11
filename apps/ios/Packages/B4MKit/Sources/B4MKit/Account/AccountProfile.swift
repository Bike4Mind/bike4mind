import Foundation

/// Who is signed in, as far as the access token's profile claims say. Display only (the greeting, the avatar
/// and the Settings header); never trusted for authorization, and every field may be missing.
public struct AccountProfile: Equatable, Sendable {
  public let firstName: String?
  public let displayName: String?
  public let email: String?

  public init(firstName: String?, displayName: String?, email: String?) {
    self.firstName = Self.clean(firstName)
    self.displayName = Self.clean(displayName)
    self.email = Self.clean(email)
  }

  /// The avatar letter: the first letter of the first name, else of the display name; `nil` when neither exists.
  public var initial: String? {
    (firstName ?? displayName)?.first.map { String($0).uppercased() }
  }

  /// `given_name` wins for the first name, otherwise the first word of `name`. The display name is `name`,
  /// otherwise `given_name` and `family_name` joined.
  init?(jwt: String) {
    let segments = jwt.split(separator: ".")
    guard segments.count == 3,
      let payload = Base64URL.decode(String(segments[1])),
      let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
    else { return nil }
    let given = Self.clean(claims["given_name"] as? String)
    let family = Self.clean(claims["family_name"] as? String)
    let name = Self.clean(claims["name"] as? String)
    let joined = [given, family].compactMap { $0 }.joined(separator: " ")
    self.init(
      firstName: given ?? name?.split(separator: " ").first.map(String.init),
      displayName: name ?? (joined.isEmpty ? nil : joined),
      email: claims["email"] as? String)
  }

  private static func clean(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
  }
}

extension AuthController {
  /// The signed-in account's profile from its access token, or `nil` when there is no readable token.
  public func profile() async -> AccountProfile? {
    guard let token = try? await accessToken() else { return nil }
    return AccountProfile(jwt: token)
  }
}
