import Foundation
import XCTest

@testable import B4MKit

/// A lock-guarded box, for test state that a `@Sendable` closure mutates.
final class Locked<Value>: @unchecked Sendable {
  private var value: Value
  private let lock = NSLock()

  init(_ value: Value) {
    self.value = value
  }

  var current: Value {
    lock.withLock { value }
  }

  func mutate<Result>(_ body: (inout Value) -> Result) -> Result {
    lock.withLock { body(&value) }
  }
}

extension TestClock {
  var provider: @Sendable () -> Date {
    { [self] in self.now }
  }
}

/// Scripted handshake: a fixed endpoint and a numbered ticket per mint.
actor FakeHandshake: RealtimeHandshaking {
  private(set) var urlLookups = 0
  private(set) var mintedTickets: [String] = []
  var ticketFailure: APIError?

  func setTicketFailure(_ failure: APIError?) { ticketFailure = failure }

  func websocketURL() throws -> URL {
    urlLookups += 1
    return URL(string: "wss://ws.example.test/prod")!
  }

  func mintTicket() throws -> String {
    if let ticketFailure { throw ticketFailure }
    let ticket = "ticket-\(mintedTickets.count + 1)"
    mintedTickets.append(ticket)
    return ticket
  }
}

/// One scripted socket. The test pushes server frames in and reads what the client sent.
final class FakeSocket: WebSocketConnection, @unchecked Sendable {
  let url: URL
  private let lock = NSLock()
  private var inbox: [String] = []
  private var waiter: CheckedContinuation<String, any Error>?
  private var closed = false
  private var _sent: [String] = []

  init(url: URL) {
    self.url = url
  }

  var sent: [String] { lock.withLock { _sent } }
  var isClosed: Bool { lock.withLock { closed } }

  /// Sent frames decoded as JSON objects; non-JSON sends are skipped.
  var sentObjects: [JSONObject] { sent.compactMap { JSONValue.parse($0)?.objectValue } }

  func sentActions(_ action: String) -> [JSONObject] {
    sentObjects.filter { $0["action"]?.stringValue == action }
  }

  /// Delivers a server frame.
  func push(_ text: String) {
    let waiter: CheckedContinuation<String, any Error>? = lock.withLock {
      if let waiter = self.waiter {
        self.waiter = nil
        return waiter
      }
      inbox.append(text)
      return nil
    }
    waiter?.resume(returning: text)
  }

  func push(_ object: JSONValue) {
    push(object.encodedString())
  }

  /// The server (or the gateway) drops the connection.
  func serverClose() {
    close()
  }

  func send(text: String) throws {
    try lock.withLock {
      if closed { throw URLError(.networkConnectionLost) }
      _sent.append(text)
    }
  }

  func receive() async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      let immediate: Result<String, any Error>? = lock.withLock {
        if !inbox.isEmpty { return .success(inbox.removeFirst()) }
        if closed { return .failure(URLError(.networkConnectionLost)) }
        waiter = continuation
        return nil
      }
      if let immediate { continuation.resume(with: immediate) }
    }
  }

  func close() {
    let waiter: CheckedContinuation<String, any Error>? = lock.withLock {
      closed = true
      let waiter = self.waiter
      self.waiter = nil
      return waiter
    }
    waiter?.resume(throwing: URLError(.networkConnectionLost))
  }
}

/// Hands out a fresh `FakeSocket` per connect and remembers them all.
final class FakeConnector: WebSocketConnecting, @unchecked Sendable {
  private let sockets = Locked<[FakeSocket]>([])
  private let failures = Locked(0)
  private let dropOnOpen = Locked(false)

  var all: [FakeSocket] { sockets.current }
  var latest: FakeSocket? { sockets.current.last }

  /// When set, every socket is dropped by the server right after the upgrade, before any frame.
  func dropSocketsOnOpen(_ drop: Bool) {
    dropOnOpen.mutate { $0 = drop }
  }

  /// The next `count` connects fail.
  func failNext(_ count: Int) {
    failures.mutate { $0 = count }
  }

  func connect(to url: URL) throws -> any WebSocketConnection {
    let shouldFail = failures.mutate { remaining -> Bool in
      guard remaining > 0 else { return false }
      remaining -= 1
      return true
    }
    if shouldFail { throw URLError(.cannotConnectToHost) }
    let socket = FakeSocket(url: url)
    sockets.mutate { $0.append(socket) }
    if dropOnOpen.current { socket.serverClose() }
    return socket
  }
}

/// Records every sleep. Durations equal to `suspending` park until cancelled (a heartbeat loop the
/// test drives by hand, the realtime slow retry tier); everything else returns at once (backoff, polling).
final class RecordingSleeper: @unchecked Sendable {
  private let recorded = Locked<[Duration]>([])
  private let suspending: Set<Duration>

  init(suspending: Set<Duration> = [.seconds(15), .seconds(300)]) {
    self.suspending = suspending
  }

  var durations: [Duration] { recorded.current }

  var sleep: @Sendable (Duration) async throws -> Void {
    { [recorded, suspending] duration in
      recorded.mutate { $0.append(duration) }
      if suspending.contains(duration) {
        try await Task.sleep(for: .seconds(3600))
      } else {
        await Task.yield()
        try Task.checkCancellation()
      }
    }
  }
}

/// Polls `condition` until it holds or the deadline passes. The realtime client runs on its own
/// tasks, so tests wait for an observable effect instead of sleeping a fixed time.
func eventually(
  timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line,
  _ condition: @Sendable () async -> Bool
) async {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if await condition() { return }
    try? await Task.sleep(for: .milliseconds(5))
  }
  XCTFail("Condition not met within \(timeout)s", file: file, line: line)
}

/// A realtime client the chat tests drive directly.
actor FakeRealtime: RealtimeClient {
  private var continuations: [UUID: AsyncStream<RealtimeEvent>.Continuation] = [:]
  private(set) var state: RealtimeConnectionState

  init(state: RealtimeConnectionState = .connected) {
    self.state = state
  }

  var connectionState: RealtimeConnectionState { state }
  var listenerCount: Int { continuations.count }

  func start() {}
  func stop() {}
  func resume() {}
  func reauthenticate(accessToken: String) {}

  func subscribe(_ request: SubscriptionRequest) -> AsyncStream<DataUpdate> {
    AsyncStream { _ in }
  }

  func events() -> AsyncStream<RealtimeEvent> {
    let (stream, continuation) = AsyncStream<RealtimeEvent>.makeStream()
    let id = UUID()
    continuations[id] = continuation
    continuation.onTermination = { [weak self] _ in Task { await self?.removeListener(id) } }
    return stream
  }

  private func removeListener(_ id: UUID) { continuations[id] = nil }

  func emit(_ event: RealtimeEvent) {
    if case .connectionChanged(let newState) = event { state = newState }
    for continuation in continuations.values { continuation.yield(event) }
  }
}
