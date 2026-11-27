import CryptoKit
import Darwin
import Foundation
import os

/// Optional storage capability: ordinary authentication still supports legacy TokenStore adapters.
public protocol SharedSessionStorage: TokenStore {
  func sharedSessionRecord() throws -> Data?
  func setSharedSessionRecord(_ data: Data?) throws
  func withSharedSessionLock<Result>(_ operation: () throws -> Result) throws -> Result
}

/// An authenticated account and one local sign-in incarnation, independent of bearer-token expiry.
public struct SharedSessionIdentity: Codable, Equatable, Sendable {
  public let userID: String
  public let baseURL: URL
  public let incarnation: UUID
}

struct SharedSessionSnapshot: Equatable, Sendable {
  let refreshToken: String
  let record: SharedSessionRecord
}

public struct SessionTermination: Codable, Equatable, Sendable {
  public enum Reason: String, Codable, Sendable {
    case userInitiated, sessionEnded, accountDeletionRequested
  }

  public let incarnation: UUID
  public let baseURL: URL
  public let userID: String?
  public let reason: Reason

  public var identity: SharedSessionIdentity? {
    guard let userID else { return nil }
    return SharedSessionIdentity(userID: userID, baseURL: baseURL, incarnation: incarnation)
  }
}

struct SharedSessionRecord: Codable, Equatable, Sendable {
  let incarnation: UUID
  let baseURL: URL
  let userID: String?
  let refreshDigest: String
  var pendingTermination: SessionTermination? = nil

  var identity: SharedSessionIdentity? {
    guard let userID else { return nil }
    return SharedSessionIdentity(userID: userID, baseURL: baseURL, incarnation: incarnation)
  }
}

enum SharedSessionError: LocalizedError {
  case changed
  case missingIdentity
  case unavailable
  case cleanupPending
  case invalidRecord

  var errorDescription: String? {
    switch self {
    case .changed: "Your sign-in changed. Reopen capture and try again."
    case .missingIdentity: "Open the app while online to confirm your account, then try again."
    case .cleanupPending: "Session cleanup must finish before signing in again."
    case .invalidRecord: "Stored session data cannot be read safely."
    case .unavailable: "Device storage is temporarily unavailable. Unlock the device and try again."
    }
  }
}

/// A producer keeps this admission across UI/network waits instead of adopting the next account.
public struct SharedSessionAdmission: Sendable {
  public let identity: SharedSessionIdentity
  private let coordinator: SharedSessionCoordinator

  init(identity: SharedSessionIdentity, coordinator: SharedSessionCoordinator) {
    self.identity = identity
    self.coordinator = coordinator
  }

  public func withCurrent<Result>(_ operation: () throws -> Result) throws -> Result {
    try coordinator.withCurrent(identity, operation)
  }
}

public protocol SharedSessionAdmissionProviding: AccessTokenProviding {
  @MainActor func captureAdmission() throws -> SharedSessionAdmission
  @MainActor func invalidateAccessToken(_ token: String, admission: SharedSessionAdmission)
  @MainActor func sessionRejected(admission: SharedSessionAdmission)
}

/// All session transitions and destructive capture admission share this short local critical section.
/// No bearer refresh, network request, actor hop or payload staging belongs inside it.
public struct SharedSessionCoordinator: Sendable {
  private let storage: any SharedSessionStorage
  private let baseURL: URL

  init?(tokenStore: any TokenStore, baseURL: URL) {
    guard let storage = tokenStore as? any SharedSessionStorage else { return nil }
    self.storage = storage
    self.baseURL = baseURL
  }

  private static func digest(_ token: String) -> String {
    SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func rawRecord() throws -> SharedSessionRecord? {
    guard let data = try storage.sharedSessionRecord() else { return nil }
    do { return try JSONDecoder().decode(SharedSessionRecord.self, from: data) }
    catch { throw SharedSessionError.invalidRecord }
  }

  private func read() throws -> SharedSessionSnapshot? {
    let record = try rawRecord()
    guard record?.pendingTermination == nil else { throw SharedSessionError.cleanupPending }
    guard let record, let token = try storage.refreshToken(),
      record.refreshDigest == Self.digest(token), record.baseURL == baseURL else { return nil }
    return SharedSessionSnapshot(refreshToken: token, record: record)
  }

  private func write(token: String, incarnation: UUID, userID: String?) throws -> SharedSessionSnapshot {
    let record = SharedSessionRecord(
      incarnation: incarnation, baseURL: baseURL, userID: userID, refreshDigest: Self.digest(token))
    // A crash between these writes leaves a mismatched pair, never an authoritative account identity.
    try storage.setRefreshToken(token)
    try storage.setSharedSessionRecord(JSONEncoder().encode(record))
    return SharedSessionSnapshot(refreshToken: token, record: record)
  }

  /// Legacy refresh-only installations gain an incarnation, but no guessed offline account identity.
  func restore() throws -> SharedSessionSnapshot? {
    try storage.withSharedSessionLock {
      if let current = try read() { return current }
      guard let token = try storage.refreshToken() else { return nil }
      if let record = try rawRecord(), record.baseURL != baseURL
      { throw SharedSessionError.changed }
      return try write(token: token, incarnation: UUID(), userID: nil)
    }
  }

  func current(incarnation: UUID) throws -> SharedSessionSnapshot {
    try storage.withSharedSessionLock {
      guard let current = try read(), current.record.incarnation == incarnation else {
        throw SharedSessionError.changed
      }
      return current
    }
  }

  func establish(token: String, userID: String?, replacing expected: SharedSessionSnapshot?) throws
    -> SharedSessionSnapshot
  {
    try storage.withSharedSessionLock {
      let tokenBeforeWrite = try storage.refreshToken()
      guard try read() == expected,
        expected != nil || tokenBeforeWrite == nil
      else { throw SharedSessionError.changed }
      return try write(token: token, incarnation: UUID(), userID: userID)
    }
  }

  func refresh(expected: SharedSessionSnapshot, token: String?, userID: String?) throws -> SharedSessionSnapshot {
    try storage.withSharedSessionLock {
      guard let current = try read(), current.record.incarnation == expected.record.incarnation,
        current.record.userID == nil || current.record.userID == userID
      else { throw SharedSessionError.changed }
      // Another process may already have rotated this same session. Never roll its token back.
      let nextToken = current.refreshToken == expected.refreshToken ? (token ?? current.refreshToken) : current.refreshToken
      return try write(token: nextToken, incarnation: current.record.incarnation, userID: userID)
    }
  }

  @discardableResult
  func end(
    incarnation: UUID, reason: SessionTermination.Reason = .sessionEnded,
    cleanup: @Sendable (SessionTermination) throws -> Void = { _ in }
  ) throws -> Bool {
    try storage.withSharedSessionLock {
      if let pending = try rawRecord()?.pendingTermination {
        guard pending.incarnation == incarnation else { return false }
        try finishTermination(pending, cleanup: cleanup)
        return true
      }
      guard let current = try read(), current.record.incarnation == incarnation else { return false }
      let termination = SessionTermination(
        incarnation: incarnation, baseURL: current.record.baseURL, userID: current.record.userID, reason: reason)
      var record = current.record
      record.pendingTermination = termination
      // Persist the barrier before deleting bytes or credentials. Partial clear remains recoverable.
      try storage.setSharedSessionRecord(JSONEncoder().encode(record))
      try finishTermination(termination, cleanup: cleanup)
      return true
    }
  }

  func recoverPendingTermination(
    cleanup: @Sendable (SessionTermination) throws -> Void
  ) throws -> SessionTermination? {
    try storage.withSharedSessionLock {
      guard let pending = try rawRecord()?.pendingTermination else { return nil }
      try finishTermination(pending, cleanup: cleanup)
      return pending
    }
  }

  private func finishTermination(
    _ termination: SessionTermination, cleanup: @Sendable (SessionTermination) throws -> Void
  ) throws {
    try cleanup(termination)
    try storage.setRefreshToken(nil)
    try storage.setSharedSessionRecord(nil)
  }

  func admission(incarnation: UUID) throws -> SharedSessionAdmission {
    guard let identity = try current(incarnation: incarnation).record.identity else {
      throw SharedSessionError.missingIdentity
    }
    return SharedSessionAdmission(identity: identity, coordinator: self)
  }

  fileprivate func withCurrent<Result>(_ identity: SharedSessionIdentity, _ operation: () throws -> Result) throws
    -> Result
  {
    try storage.withSharedSessionLock {
      guard try read()?.record.identity == identity else { throw SharedSessionError.changed }
      return try operation()
    }
  }
}

/// Independent app/extension file handles lock the same inode; the lock lives outside capture cleanup.
struct SharedSessionFileLock: Sendable {
  let url: URL

  func withLock<Result>(_ operation: () throws -> Result) throws -> Result {
    let lease = try acquire()
    defer { lease.release() }
    return try operation()
  }

  func acquire(shared: Bool = false) throws -> SharedSessionFileLease {
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch let error as CocoaError where error.code == .fileReadNoPermission || error.code == .fileWriteNoPermission {
      throw SharedSessionError.unavailable
    }
    let descriptor = open(url.path(percentEncoded: false), O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw lockError() }
    while flock(descriptor, shared ? LOCK_SH : LOCK_EX) != 0 {
      guard errno == EINTR else {
        let error = lockError()
        close(descriptor)
        throw error
      }
    }
    return SharedSessionFileLease(descriptor: descriptor)
  }

  private func lockError() -> any Error {
    if errno == EACCES || errno == EPERM { return SharedSessionError.unavailable }
    return POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }
}

/// Explicit release permits a payload writer to drop its lease before reacquiring the identity lock.
final class SharedSessionFileLease: Sendable {
  private let descriptor: OSAllocatedUnfairLock<Int32?>

  init(descriptor: Int32) {
    self.descriptor = OSAllocatedUnfairLock(initialState: descriptor)
  }

  func release() {
    let value = descriptor.withLock { current in
      let value = current
      current = nil
      return value
    }
    if let value {
      _ = flock(value, LOCK_UN)
      close(value)
    }
  }

  deinit { release() }
}
