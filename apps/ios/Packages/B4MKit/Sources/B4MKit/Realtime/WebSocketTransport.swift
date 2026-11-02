import Foundation

/// The seam between `WSClient` and the socket. Tests script a fake; production uses
/// `URLSessionWebSocketTask`.
public protocol WebSocketConnecting: Sendable {
  func connect(to url: URL) async throws -> any WebSocketConnection
}

public protocol WebSocketConnection: Sendable {
  func send(text: String) async throws
  /// The next text frame. Binary frames are surfaced as their UTF-8 decoding. Throws once the
  /// connection is closed, for any reason.
  func receive() async throws -> String
  func close()
}

public struct URLSessionWebSocketConnector: WebSocketConnecting {
  private let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func connect(to url: URL) async throws -> any WebSocketConnection {
    let task = session.webSocketTask(with: url)
    task.resume()
    return URLSessionWebSocketConnection(task: task)
  }
}

/// `URLSessionWebSocketTask` is thread-safe but not annotated `Sendable`.
private final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
  private let task: URLSessionWebSocketTask

  init(task: URLSessionWebSocketTask) {
    self.task = task
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
