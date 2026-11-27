import Foundation
import os

/// A signed-out session the server has not confirmed revoked yet, kept only to finish that revocation.
public struct PendingRevocation: Codable, Equatable, Sendable {
  /// The server's refresh-session lifetime (`DEFAULT_REFRESH_TTL_MS` in b4m-core/services authSessionService).
  public static let maxAge: TimeInterval = 30 * 24 * 60 * 60
  public static let maxCount = 10

  public let baseURL: URL
  public let refreshToken: String
  public let createdAt: Date

  public init(baseURL: URL, refreshToken: String, createdAt: Date) {
    self.baseURL = baseURL
    self.refreshToken = refreshToken
    self.createdAt = createdAt
  }

  /// Drops entries past the refresh lifetime and keeps only the newest `maxCount`.
  public static func bounded(_ revocations: [PendingRevocation], now: Date) -> [PendingRevocation] {
    Array(revocations.filter { now.timeIntervalSince($0.createdAt) < maxAge }.suffix(maxCount))
  }
}

enum PendingRevocationCodec {
  private struct Stored: Decodable {
    let baseURL: URL
    let refreshToken: String
    let createdAt: Date?
  }

  static func load(_ data: Data, now: Date, persist: (Data) throws -> Void) throws -> [PendingRevocation] {
    let stored = try JSONDecoder().decode([Stored].self, from: data)
    let values = stored.map {
      PendingRevocation(baseURL: $0.baseURL, refreshToken: $0.refreshToken, createdAt: $0.createdAt ?? now)
    }
    if stored.contains(where: { $0.createdAt == nil }) {
      try persist(JSONEncoder().encode(values))
    }
    return values
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
