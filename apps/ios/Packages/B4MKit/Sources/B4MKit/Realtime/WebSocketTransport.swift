import Foundation

/// The seam between `WSClient` and the socket. Tests script a fake; production uses
/// `URLSessionWebSocketTask`.
public protocol WebSocketConnecting: Sendable {
  /// Returns only once the WebSocket upgrade has completed; throws when it is refused or never answers.
  func connect(to url: URL) async throws -> any WebSocketConnection
}

public protocol WebSocketConnection: Sendable {
  func send(text: String) async throws
  /// The next text frame. Binary frames are surfaced as their UTF-8 decoding. Throws once the
  /// connection is closed, for any reason.
  func receive() async throws -> String
  func close()
}

public final class URLSessionWebSocketConnector: WebSocketConnecting {
  private let session: URLSession
  private let observer: WebSocketOpenObserver
  private let openTimeout: Duration

  private let identity: ClientIdentity

  /// - Parameter openTimeout: how long the upgrade may take before the attempt counts as failed.
  public init(
    configuration: URLSessionConfiguration = .default, openTimeout: Duration = .seconds(20),
    identity: ClientIdentity = .current
  ) {
    let observer = WebSocketOpenObserver()
    self.observer = observer
    self.openTimeout = openTimeout
    self.identity = identity
    session = URLSession(configuration: configuration, delegate: observer, delegateQueue: nil)
  }

  deinit {
    session.finishTasksAndInvalidate()
  }

  public func connect(to url: URL) async throws -> any WebSocketConnection {
    // `resume()` returns before the upgrade; a refused upgrade (403/429/5xx, bad host) only surfaces
    // through the delegate, so wait for the open event before reporting a connection.
    var request = URLRequest(url: url)
    identity.apply(to: &request)
    let connection = URLSessionWebSocketConnection(task: session.webSocketTask(with: request))
    let openTimeout = self.openTimeout
    let timeout = Task {
      try await Task.sleep(for: openTimeout)
      connection.close()
    }
    defer { timeout.cancel() }
    try await withTaskCancellationHandler {
      try await observer.waitForOpen(connection)
    } onCancel: {
      connection.close()
    }
    return connection
  }
}

/// Resolves each task's open wait from the session delegate callbacks.
private final class WebSocketOpenObserver: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var waiters: [Int: CheckedContinuation<Void, any Error>] = [:]

  func waitForOpen(_ connection: URLSessionWebSocketConnection) async throws {
    try await withCheckedThrowingContinuation { continuation in
      lock.withLock { waiters[connection.taskIdentifier] = continuation }
      connection.resume()
    }
  }

  private func finish(_ taskIdentifier: Int, with result: Result<Void, any Error>) {
    let waiter = lock.withLock { waiters.removeValue(forKey: taskIdentifier) }
    waiter?.resume(with: result)
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
  ) {
    finish(webSocketTask.taskIdentifier, with: .success(()))
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    finish(webSocketTask.taskIdentifier, with: .failure(URLError(.networkConnectionLost)))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    finish(task.taskIdentifier, with: .failure(error ?? URLError(.cannotConnectToHost)))
  }
}

/// `URLSessionWebSocketTask` is thread-safe but not annotated `Sendable`.
private final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
  private let task: URLSessionWebSocketTask

  init(task: URLSessionWebSocketTask) {
    self.task = task
  }

  var taskIdentifier: Int { task.taskIdentifier }

  func resume() {
    task.resume()
  }

  func send(text: String) async throws {
    try await task.send(.string(text))
  }

  func receive() async throws -> String {
    switch try await task.receive() {
    case .string(let text): return text
    case .data(let data): return String(decoding: data, as: UTF8.self)
    @unknown default: return ""
    }
  }

  func close() {
    task.cancel(with: .normalClosure, reason: nil)
  }
}
