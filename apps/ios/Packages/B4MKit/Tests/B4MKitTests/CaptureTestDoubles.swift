import Foundation
import XCTest

@testable import B4MKit

/// Scripted `CaptureAPI`. Records calls in order; each operation can be made to fail.
actor FakeCaptureAPI: CaptureAPI {
  enum Call: Equatable {
    case createUpload(name: String, mime: String, size: Int)
    case fileStatus(String)
    case setNotes(file: String, notes: String)
    case addToLake(lake: String, file: String)
    case sendMessage(session: String, message: String, files: [String])
    case findSentTurn(session: String, message: String)
  }

  private(set) var calls: [Call] = []
  var statuses: [RemoteFileStatus] = [.clean]
  var createUploadError: (any Error)?
  var statusError: (any Error)?
  var attachError: (any Error)?
  var lakePages: [String?: Page<LakeSummary>] = [:]
  var sentTurnLookup: SentTurnLookup = .notFound
  private var statusIndex = 0
  private var ticketCount = 0

  func setStatuses(_ statuses: [RemoteFileStatus]) {
    self.statuses = statuses
    statusIndex = 0
  }

  func setCreateUploadError(_ error: (any Error)?) { createUploadError = error }
  func setAttachError(_ error: (any Error)?) { attachError = error }
  func setStatusError(_ error: (any Error)?) { statusError = error }

  func createUpload(fileName: String, mimeType: String, byteCount: Int) async throws -> UploadTicket {
    calls.append(.createUpload(name: fileName, mime: mimeType, size: byteCount))
    if let createUploadError { throw createUploadError }
    ticketCount += 1
    return UploadTicket(
      fileID: "file-\(ticketCount)", uploadURL: URL(string: "https://s3.example.test/put/\(ticketCount)")!,
      expiresAt: Date(timeIntervalSince1970: 2_000_000_000))
  }

  func fileStatus(fileID: String) async throws -> RemoteFileStatus {
    calls.append(.fileStatus(fileID))
    if let statusError { throw statusError }
    let status = statuses[min(statusIndex, statuses.count - 1)]
    statusIndex += 1
    return status
  }

  func setNotes(fileID: String, notes: String) async throws {
    calls.append(.setNotes(file: fileID, notes: notes))
    if let attachError { throw attachError }
  }

  func listLakes(cursor: String?, limit: Int) async throws -> Page<LakeSummary> {
    lakePages[cursor] ?? Page(items: [], nextCursor: nil)
  }

  func addFileToLake(lakeID: String, fileID: String) async throws {
    calls.append(.addToLake(lake: lakeID, file: fileID))
    if let attachError { throw attachError }
  }

  func sendSessionMessage(sessionID: String, message: String, fileIDs: [String]) async throws {
    calls.append(.sendMessage(session: sessionID, message: message, files: fileIDs))
    if let attachError { throw attachError }
  }

  func setLakePages(_ pages: [String?: Page<LakeSummary>]) { lakePages = pages }
  func setSentTurnLookup(_ lookup: SentTurnLookup) { sentTurnLookup = lookup }

  func findSentTurn(sessionID: String, message: String, sentAfter: Date) async throws -> SentTurnLookup {
    calls.append(.findSentTurn(session: sessionID, message: message))
    return sentTurnLookup
  }
}

/// Background session stand-in: records started PUTs, reports which are "live", and lets a test emit events.
final class FakeUploader: BackgroundUploading, @unchecked Sendable {
  struct Started: Equatable {
    let jobID: UUID
    let taskID: Int
    let url: URL
    let contentType: String
    let file: URL
  }

  let identifier: String
  private let lock = NSLock()
  private var _started: [Started] = []
  private var live: Set<UUID> = []
  private var nextTask = 100
  private let stream: AsyncStream<UploadEvent>
  private let continuation: AsyncStream<UploadEvent>.Continuation

  init(identifier: String = BackgroundSessionIdentifier.app) {
    self.identifier = identifier
    (stream, continuation) = AsyncStream<UploadEvent>.makeStream()
  }

  var started: [Started] { lock.withLock { _started } }

  func start(jobID: UUID, file: URL, to url: URL, contentType: String) async throws -> Int {
    lock.withLock {
      nextTask += 1
      _started.append(Started(jobID: jobID, taskID: nextTask, url: url, contentType: contentType, file: file))
      live.insert(jobID)
      return nextTask
    }
  }

  func liveJobIDs() async -> Set<UUID> { lock.withLock { live } }
  func events() -> AsyncStream<UploadEvent> { stream }

  /// Registers a task started by another process, so a reattached session reports it as live.
  func adopt(jobID: UUID, taskID: Int) {
    lock.withLock {
      _started.append(
        Started(
          jobID: jobID, taskID: taskID, url: URL(string: "https://s3.example.test/adopted")!, contentType: "x",
          file: URL(fileURLWithPath: "/dev/null")))
      live.insert(jobID)
    }
  }

  /// Simulates a task that finished: no longer live, event delivered.
  func finish(_ jobID: UUID, outcome: UploadEvent.Outcome = .succeeded) {
    let taskID = lock.withLock { () -> Int in
      live.remove(jobID)
      return _started.last { $0.jobID == jobID }?.taskID ?? -1
    }
    continuation.yield(UploadEvent(jobID: jobID, taskID: taskID, outcome: outcome))
  }

  /// Simulates a task the system lost (no event, not live).
  func vanish(_ jobID: UUID) { _ = lock.withLock { live.remove(jobID) } }
}

final class TempDirectory: @unchecked Sendable {
  let url: URL

  init() {
    url = FileManager.default.temporaryDirectory.appending(path: "b4m-capture-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  deinit { try? FileManager.default.removeItem(at: url) }

  func file(_ name: String, contents: Data = Data("hello".utf8)) -> URL {
    let location = url.appending(path: name)
    try? contents.write(to: location)
    return location
  }
}

func sharedFile(_ temp: TempDirectory, name: String = "photo.jpg", mime: String = "image/jpeg") -> SharedFile {
  let url = temp.file(name)
  return SharedFile(fileURL: url, fileName: name, mimeType: mime, byteCount: 5)
}

/// `AttachmentSource` with scripted representations.
struct FakeAttachment: AttachmentSource {
  var typeIdentifiers: [String]
  var suggestedName: String?
  var url: URL?
  var text: String?
  var file: URL?

  func loadURL() async throws -> URL {
    guard let url else { throw ShareItemLoadError.unsupported }
    return url
  }

  func loadText() async throws -> String {
    guard let text else { throw ShareItemLoadError.unsupported }
    return text
  }

  func loadFile(typeIdentifier: String) async throws -> URL {
    guard let file else { throw ShareItemLoadError.unsupported }
    return file
  }
}
