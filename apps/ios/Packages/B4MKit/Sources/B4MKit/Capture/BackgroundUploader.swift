import Foundation
import os

/// A finished PUT, as reported by the background session's delegate.
public struct UploadEvent: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    case succeeded
    /// `status` is nil for a transport failure.
    case failed(status: Int?)
  }

  public let jobID: UUID
  public let taskID: Int
  public let outcome: Outcome

  public init(jobID: UUID, taskID: Int, outcome: Outcome) {
    self.jobID = jobID
    self.taskID = taskID
    self.outcome = outcome
  }
}

/// Names of the background `URLSession`s. The app and the share extension each need their own: one
/// identifier cannot be shared between processes. When the extension's upload finishes while nothing is
/// running, the system relaunches the *app* with the extension's identifier, so the app must be able to
/// re-create either session (`AppDelegate.handleEventsForBackgroundURLSession`).
public enum BackgroundSessionIdentifier {
  public static let app = "com.bike4mind.app.capture"
  public static let shareExtension = "com.bike4mind.app.ShareExtension.capture"

  /// Whether `identifier` names one of ours (the system also relaunches for other libraries' sessions).
  public static func isCaptureSession(_ identifier: String) -> Bool {
    identifier == app || identifier == shareExtension
  }
}

/// Hands file bytes to a session that outlives the process.
public protocol BackgroundUploading: Sendable {
  var identifier: String { get }
  /// Starts a PUT of `file` to `url` and returns the session's task id for it.
  func start(jobID: UUID, file: URL, to url: URL, contentType: String) async throws -> Int
  /// Job ids with an unfinished task in this session.
  func liveJobIDs() async -> Set<UUID>
  /// Completions, including those that happened while the process was dead (delivered once the session is
  /// re-created). One consumer only.
  func events() -> AsyncStream<UploadEvent>
}

/// The real background session. The PUT carries no `Authorization` header: the presigned signature is the
/// credential.
public final class URLSessionBackgroundUploader: BackgroundUploading, @unchecked Sendable {
  public let identifier: String
  private let session: URLSession
  private let relay: Relay

  public init(identifier: String) {
    self.identifier = identifier
    let relay = Relay()
    let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedContainer.appGroupIdentifier)
      != nil
    {
      configuration.sharedContainerIdentifier = SharedContainer.appGroupIdentifier
    }
    self.relay = relay
    session = URLSession(configuration: configuration, delegate: relay, delegateQueue: nil)
  }

  /// The closure the system passed to `handleEventsForBackgroundURLSession`; invoked on the main thread
  /// once every queued event has been delivered, as the system requires.
  public func adoptSystemCompletionHandler(_ handler: @escaping @Sendable () -> Void) {
    relay.setSystemCompletion(handler)
  }

  public func start(jobID: UUID, file: URL, to url: URL, contentType: String) async throws -> Int {
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    let task = session.uploadTask(with: request, fromFile: file)
    task.taskDescription = jobID.uuidString
    task.resume()
    return task.taskIdentifier
  }

  public func liveJobIDs() async -> Set<UUID> {
    let tasks = await session.allTasks
    return Set(
      tasks.filter { $0.state == .running || $0.state == .suspended }
        .compactMap { $0.taskDescription.flatMap(UUID.init(uuidString:)) })
  }

  public func events() -> AsyncStream<UploadEvent> { relay.stream }

  private final class Relay: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let stream: AsyncStream<UploadEvent>
    private let continuation: AsyncStream<UploadEvent>.Continuation
    private struct Completion {
      var handler: (@Sendable () -> Void)?
      /// The session finished delivering events before the system's handler was adopted.
      var eventsFinishedEarly = false
    }
    private let systemCompletion = OSAllocatedUnfairLock(initialState: Completion())

    override init() {
      (stream, continuation) = AsyncStream<UploadEvent>.makeStream(bufferingPolicy: .unbounded)
      super.init()
    }

    func setSystemCompletion(_ handler: @escaping @Sendable () -> Void) {
      let runNow = systemCompletion.withLock { completion in
        if completion.eventsFinishedEarly {
          completion.eventsFinishedEarly = false
          return true
        }
        completion.handler = handler
        return false
      }
      if runNow { DispatchQueue.main.async(execute: handler) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
      guard let jobID = task.taskDescription.flatMap(UUID.init(uuidString:)) else { return }
      let status = (task.response as? HTTPURLResponse)?.statusCode
      let outcome: UploadEvent.Outcome =
        if error == nil, let status, (200..<300).contains(status) { .succeeded } else { .failed(status: status) }
      continuation.yield(UploadEvent(jobID: jobID, taskID: task.taskIdentifier, outcome: outcome))
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
      let handler = systemCompletion.withLock { completion in
        defer { completion.handler = nil }
        if completion.handler == nil { completion.eventsFinishedEarly = true }
        return completion.handler
      }
      if let handler { DispatchQueue.main.async(execute: handler) }
    }
  }
}
