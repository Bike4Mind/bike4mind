import Foundation
import Security

public struct KeychainError: Error, Equatable, Sendable {
  public let status: OSStatus

  public init(status: OSStatus) {
    self.status = status
  }

  /// The item exists but cannot be read yet: a launch before first unlock (push, Live Activity) gets
  /// `errSecInteractionNotAllowed`. Retrying once protected data is available succeeds.
  public var isTransient: Bool {
    status == errSecInteractionNotAllowed || status == errSecNotAvailable
  }
}

/// Generic-password Keychain item, readable after first unlock so background refreshes
/// (and, later, the share extension via `accessGroup`) work while the device is locked.
public struct KeychainTokenStore: SharedSessionStorage {
  private let service: String
  private let account: String
  private let accessGroup: String?

  public init(service: String = "com.bike4mind.auth", account: String = "refreshToken", accessGroup: String? = nil) {
    self.service = service
    self.account = account
    self.accessGroup = accessGroup
  }

  /// Whether a failed operation against the shared access group should be retried app-private: only when a
  /// group was requested and the system rejected it for a missing entitlement (a signed build without
  /// Keychain Sharing). Every other failure is a real error and must surface.
  static func shouldFallBackToPrivate(status: OSStatus, accessGroup: String?) -> Bool {
    accessGroup != nil && status == errSecMissingEntitlement
  }

  private func itemQuery(sharedGroup: Bool) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if sharedGroup, let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }

  /// Same service and access group, separate item: never read as the live session.
  private var pendingRevocationItem: KeychainTokenStore {
    KeychainTokenStore(service: service, account: "\(account).pendingRevocations", accessGroup: accessGroup)
  }

  private var sessionIdentityItem: KeychainTokenStore {
    KeychainTokenStore(service: service, account: "\(account).sessionIdentity", accessGroup: accessGroup)
  }

  public func sharedSessionRecord() throws -> Data? {
    try sessionIdentityItem.refreshToken().map { Data($0.utf8) }
  }

  public func setSharedSessionRecord(_ data: Data?) throws {
    try sessionIdentityItem.setRefreshToken(data.map { String(decoding: $0, as: UTF8.self) })
  }

  public func withSharedSessionLock<Result>(_ operation: () throws -> Result) throws -> Result {
    try SharedSessionFileLock(url: SharedContainer.directory().appending(path: "AuthSession.lock"))
      .withLock(operation)
  }

  public func pendingRevocations() throws -> [PendingRevocation] {
    guard let json = try pendingRevocationItem.refreshToken() else { return [] }
    return (try? JSONDecoder().decode([PendingRevocation].self, from: Data(json.utf8))) ?? []
  }

  public func setPendingRevocations(_ revocations: [PendingRevocation]) throws {
    guard !revocations.isEmpty else {
      try pendingRevocationItem.setRefreshToken(nil)
      return
    }
    let json = String(decoding: try JSONEncoder().encode(revocations), as: UTF8.self)
    try pendingRevocationItem.setRefreshToken(json)
  }

  public func refreshToken() throws -> String? {
    do {
      return try readToken(sharedGroup: true)
    } catch let error as KeychainError
      where Self.shouldFallBackToPrivate(status: error.status, accessGroup: accessGroup)
    {
      return try readToken(sharedGroup: false)
    }
  }

  public func setRefreshToken(_ token: String?) throws {
    guard let token else {
      try deleteToken()
      return
    }
    do {
      try writeToken(token, sharedGroup: true)
    } catch let error as KeychainError
      where Self.shouldFallBackToPrivate(status: error.status, accessGroup: accessGroup)
    {
      try writeToken(token, sharedGroup: false)
    }
  }

  private func readToken(sharedGroup: Bool) throws -> String? {
    var query = itemQuery(sharedGroup: sharedGroup)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let data = result as? Data else { throw KeychainError(status: errSecDecode) }
      return String(decoding: data, as: UTF8.self)
    case errSecItemNotFound:
      return nil
    default:
      throw KeychainError(status: status)
    }
  }

  /// Clears both locations so a session written app-private (no entitlement) cannot outlive sign-out.
  private func deleteToken() throws {
    for sharedGroup in accessGroup == nil ? [false] : [true, false] {
      let status = SecItemDelete(itemQuery(sharedGroup: sharedGroup) as CFDictionary)
      let tolerated =
        status == errSecSuccess || status == errSecItemNotFound
        || (sharedGroup && Self.shouldFallBackToPrivate(status: status, accessGroup: accessGroup))
      guard tolerated else { throw KeychainError(status: status) }
    }
  }

  private func writeToken(_ token: String, sharedGroup: Bool) throws {
    let base = itemQuery(sharedGroup: sharedGroup)
    // ThisDeviceOnly: a rotating refresh token must not ride an encrypted backup onto a second device,
    // where both copies would race to rotate it. After-first-unlock still lets the share extension and
    // background refreshes read it. The update rewrites the attribute on items stored before this change.
    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updateStatus = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else { throw KeychainError(status: updateStatus) }

    let addStatus = SecItemAdd(base.merging(attributes) { $1 } as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
  }
}
