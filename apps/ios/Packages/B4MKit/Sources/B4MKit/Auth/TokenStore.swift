import Foundation
import os

/// A signed-out session the server has not confirmed revoked yet, kept only to finish that revocation.
public struct PendingRevocation: Codable, Equatable, Sendable {
  public let baseURL: URL
  public let refreshToken: String

  public init(baseURL: URL, refreshToken: String) {
    self.baseURL = baseURL
    self.refreshToken = refreshToken
  }
}

/// Durable home of the refresh token. The access token is never persisted.
public protocol TokenStore: Sendable {
  func refreshToken() throws -> String?
  /// `nil` deletes the stored token.
  func setRefreshToken(_ token: String?) throws
  func pendingRevocations() throws -> [PendingRevocation]
  /// An empty list deletes the stored item.
  func setPendingRevocations(_ revocations: [PendingRevocation]) throws
}

public final class InMemoryTokenStore: SharedSessionStorage {
  private let storage: OSAllocatedUnfairLock<String?>
  private let pending = OSAllocatedUnfairLock<[PendingRevocation]>(initialState: [])
  private let sessionRecord = OSAllocatedUnfairLock<Data?>(initialState: nil)
  private let sessionLock = NSLock()

  public init(refreshToken: String? = nil) {
    storage = OSAllocatedUnfairLock(initialState: refreshToken)
  }

  public func refreshToken() throws -> String? {
    storage.withLock { $0 }
  }

  public func setRefreshToken(_ token: String?) throws {
    storage.withLock { $0 = token }
  }

  public func pendingRevocations() throws -> [PendingRevocation] {
    pending.withLock { $0 }
  }

  public func setPendingRevocations(_ revocations: [PendingRevocation]) throws {
    pending.withLock { $0 = revocations }
  }

  public func sharedSessionRecord() throws -> Data? {
    sessionRecord.withLock { $0 }
  }

  public func setSharedSessionRecord(_ data: Data?) throws {
    sessionRecord.withLock { $0 = data }
  }

  public func withSharedSessionLock<Result>(_ operation: () throws -> Result) throws -> Result {
    sessionLock.lock()
    defer { sessionLock.unlock() }
    return try operation()
  }
}
