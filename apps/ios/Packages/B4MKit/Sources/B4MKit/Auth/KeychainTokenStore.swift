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
public struct KeychainTokenStore: TokenStore {
  private let service: String
  private let account: String
  private let accessGroup: String?

  public init(service: String = "com.bike4mind.auth", account: String = "refreshToken", accessGroup: String? = nil) {
    self.service = service
    self.account = account
    self.accessGroup = accessGroup
  }

  private var baseQuery: [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }

  public func refreshToken() throws -> String? {
    var query = baseQuery
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

  public func setRefreshToken(_ token: String?) throws {
    guard let token else {
      let status = SecItemDelete(baseQuery as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
      return
    }

    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else { throw KeychainError(status: updateStatus) }

    let addStatus = SecItemAdd(baseQuery.merging(attributes) { $1 } as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
  }
}
