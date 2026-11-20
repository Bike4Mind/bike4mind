import Foundation

/// Who is signed in, from the self view of `GET /api/users/{id}`. Display only (the greeting, the avatar and the
/// Settings header); never trusted for authorization, and every field may be missing. The access token carries no
/// profile claims (only the user id), so the profile always comes from the server.
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

  /// `name` is the display name and its first word the first name. Without a `name`, the `username` stands in as
  /// the display name only: a handle reads wrong in "Good morning, <first name>".
  init?(userJSON: Data) {
    guard let user = try? JSONSerialization.jsonObject(with: userJSON) as? [String: Any] else { return nil }
    let name = Self.clean(user["name"] as? String)
    self.init(
      firstName: name?.split(separator: " ").first.map(String.init),
      displayName: name ?? (user["username"] as? String),
      email: user["email"] as? String)
  }

  /// The user id in a Bike4Mind access token (its `id` claim). Unverified on purpose: it only picks which profile
  /// to ask for, and the server still authorizes that request against the bearer.
  static func userID(fromAccessToken token: String) -> String? {
    let segments = token.split(separator: ".")
    guard segments.count == 3,
      let payload = Base64URL.decode(String(segments[1])),
      let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
      let id = claims["id"] as? String,
      DeepLinkRouter.isValidIdentifier(id)
    else { return nil }
    return id
  }

  private static func clean(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
  }
}

extension AuthController {
  /// The signed-in user's id from the access token, or `nil` when there is no readable session.
  public func userID() async -> String? {
    guard let token = try? await accessToken() else { return nil }
    return AccountProfile.userID(fromAccessToken: token)
  }
}
