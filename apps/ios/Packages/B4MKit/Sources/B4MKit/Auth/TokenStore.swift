import Foundation
import os

/// Durable home of the refresh token. The access token is never persisted.
public protocol TokenStore: Sendable {
  func refreshToken() throws -> String?
  /// `nil` deletes the stored token.
  func setRefreshToken(_ token: String?) throws
}

public final class InMemoryTokenStore: TokenStore {
  private let storage: OSAllocatedUnfairLock<String?>

  public init(refreshToken: String? = nil) {
    storage = OSAllocatedUnfairLock(initialState: refreshToken)
  }

  public func refreshToken() throws -> String? {
    storage.withLock { $0 }
  }

  public func setRefreshToken(_ token: String?) throws {
    storage.withLock { $0 = token }
  }
}
