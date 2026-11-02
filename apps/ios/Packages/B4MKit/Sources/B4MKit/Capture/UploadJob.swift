import Foundation

/// Where one capture is in its journey to the server.
///
/// ```
/// queued --(mint ticket, hand bytes to the background session)--> uploading
/// uploading --(PUT answered 2xx)--> registering          uploading --(PUT failed, attempts left)--> queued
/// registering --(scanned clean, attached to its destination)--> done
/// any --(permanent refusal, attempts exhausted)--> failed        failed --(retry)--> queued
/// ```
public enum UploadStage: String, Codable, Sendable {
  case queued, uploading, registering, done, failed

  public var isTerminal: Bool { self == .done || self == .failed }
}

/// What a job sends. A file's bytes live in the job's payload directory (see `UploadJobStore`).
public enum UploadPayload: Codable, Hashable, Sendable {
  case file(name: String, mimeType: String, byteCount: Int)
  /// No upload: the text goes straight into a session message.
  case message(String)
}

/// One persisted capture. Persisted on every transition so the app can finish what a reaped share
/// extension (or a killed app) started.
public struct UploadJob: Codable, Identifiable, Equatable, Sendable {
  public let id: UUID
  public let destination: CaptureDestination
  public let payload: UploadPayload
  public let note: String?
  public let createdAt: Date

  public internal(set) var stage: UploadStage
  public internal(set) var ticket: UploadTicket?
  /// Identifier of the background session that owns the in-flight PUT, and that session's task id.
  public internal(set) var uploadSession: String?
  public internal(set) var uploadTaskID: Int?
  /// PUTs started so far; bounds the retry loop.
  public internal(set) var uploadAttempts: Int
  /// The most recent problem, whether the job is waiting to retry or has failed.
  public internal(set) var lastError: String?
  public internal(set) var updatedAt: Date

  public init(
    id: UUID = UUID(), destination: CaptureDestination, payload: UploadPayload, note: String?, now: Date
  ) {
    self.id = id
    self.destination = destination
    self.payload = payload
    self.note = note
    self.createdAt = now
    self.stage = .queued
    self.ticket = nil
    self.uploadSession = nil
    self.uploadTaskID = nil
    self.uploadAttempts = 0
    self.lastError = nil
    self.updatedAt = now
  }

  public var displayName: String {
    switch payload {
    case .file(let name, _, _): name
    case .message(let text): String(text.prefix(60))
    }
  }
}

/// Durable home of jobs and their payload files, shared between the app and the share extension.
public protocol UploadJobStore: Sendable {
  func loadAll() throws -> [UploadJob]
  func load(id: UUID) throws -> UploadJob?
  func save(_ job: UploadJob) throws
  /// Removes the job and its payload.
  func remove(id: UUID) throws
  /// Where the job's file bytes live (the file may not exist yet).
  func payloadURL(jobID: UUID, fileName: String) -> URL
  /// Copies `source` into the job's payload directory and returns the new location.
  func stagePayload(copying source: URL, jobID: UUID, fileName: String) throws -> URL
  func writePayload(_ data: Data, jobID: UUID, fileName: String) throws -> URL
  func discardPayload(jobID: UUID)
}

/// One JSON file per job, so the app and the extension (separate processes) never rewrite each other's
/// records. Writes are atomic.
public struct FileUploadJobStore: UploadJobStore {
  private let root: URL

  public init(directory: URL = SharedContainer.directory()) {
    root = directory.appending(path: "Capture", directoryHint: .isDirectory)
  }

  private var jobsDirectory: URL { root.appending(path: "jobs", directoryHint: .isDirectory) }

  private func jobURL(_ id: UUID) -> URL { jobsDirectory.appending(path: "\(id.uuidString).json") }

  private func payloadDirectory(_ id: UUID) -> URL {
    root.appending(path: "payloads", directoryHint: .isDirectory).appending(
      path: id.uuidString, directoryHint: .isDirectory)
  }

  public func loadAll() throws -> [UploadJob] {
    guard FileManager.default.fileExists(atPath: jobsDirectory.path(percentEncoded: false)) else { return [] }
    let urls = try FileManager.default.contentsOfDirectory(at: jobsDirectory, includingPropertiesForKeys: nil)
    let decoder = Self.decoder
    // A record being written by the other process, or damaged, must not hide every other job.
    return urls.filter { $0.pathExtension == "json" }
      .compactMap { (try? Data(contentsOf: $0)).flatMap { try? decoder.decode(UploadJob.self, from: $0) } }
      .sorted { ($0.createdAt, $0.id.uuidString) < ($1.createdAt, $1.id.uuidString) }
  }

  public func load(id: UUID) throws -> UploadJob? {
    guard let data = try? Data(contentsOf: jobURL(id)) else { return nil }
    return try Self.decoder.decode(UploadJob.self, from: data)
  }

  public func save(_ job: UploadJob) throws {
    try FileManager.default.createDirectory(at: jobsDirectory, withIntermediateDirectories: true)
    try Self.encoder.encode(job).write(to: jobURL(job.id), options: .atomic)
  }

  public func remove(id: UUID) throws {
    discardPayload(jobID: id)
    do {
      try FileManager.default.removeItem(at: jobURL(id))
    } catch CocoaError.fileNoSuchFile {
      return
    }
  }

  public func payloadURL(jobID: UUID, fileName: String) -> URL {
    payloadDirectory(jobID).appending(path: fileName)
  }

  public func stagePayload(copying source: URL, jobID: UUID, fileName: String) throws -> URL {
    let destination = payloadURL(jobID: jobID, fileName: fileName)
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: source, to: destination)
    return destination
  }

  public func writePayload(_ data: Data, jobID: UUID, fileName: String) throws -> URL {
    let destination = payloadURL(jobID: jobID, fileName: fileName)
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: destination, options: .atomic)
    return destination
  }

  public func discardPayload(jobID: UUID) {
    try? FileManager.default.removeItem(at: payloadDirectory(jobID))
  }

  private static var encoder: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }

  private static var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}

/// The restore decision for a job found `uploading` after a relaunch, kept pure so it is testable without
/// a URLSession.
public enum UploadReconciler {
  /// `true` when the job's PUT is gone and the job must go back to `queued`.
  ///
  /// - A PUT owned by this process's session is live iff the session still lists its task. A finished task's
  ///   completion event is delivered separately; if it never was, the PUT is lost.
  /// - A PUT owned by another session (the share extension's) cannot be inspected from here, and the system
  ///   relaunches the app with that session's identifier when it finishes, so it is left alone until it is
  ///   older than `foreignStaleAfter`, then retried under this session.
  public static func shouldRequeue(
    _ job: UploadJob, liveJobIDs: Set<UUID>, ownIdentifier: String, now: Date, foreignStaleAfter: TimeInterval
  ) -> Bool {
    guard job.stage == .uploading else { return false }
    switch job.uploadSession {
    case ownIdentifier: return !liveJobIDs.contains(job.id)
    case nil: return true
    default: return now.timeIntervalSince(job.updatedAt) > foreignStaleAfter
    }
  }
}
