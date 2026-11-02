import Foundation
import os

public enum RealtimeConnectionState: Equatable, Sendable {
  /// Not started, or stopped.
  case idle
  case connecting(attempt: Int)
  case connected
  case waitingToReconnect(attempt: Int)
  /// Reconnect attempts are exhausted; `resume()` (on app foreground) starts over.
  case suspended
}

public enum RealtimeEvent: Equatable, Sendable {
  /// A server frame routed by `action` (chat streaming, agent runs, ...). Unknown actions arrive here
  /// too; consumers ignore what they do not understand.
  case frame(ActionFrame)
  case connectionChanged(RealtimeConnectionState)
  /// The socket came back after a drop. Frames sent while it was down are gone for good, so anything
  /// rendered from live frames must be refetched over REST.
  case refetchNeeded
  case subscriptionFailed(subscriptionID: String, message: String)
}

/// The realtime surface the app and later features depend on. `WSClient` is the production
/// implementation; tests and fixture mode substitute their own.
public protocol RealtimeClient: AnyObject, Sendable {
  func start() async
  func stop() async
  /// Call when the app returns to the foreground: restarts a client that gave up reconnecting.
  func resume() async
  /// Moves the open connection onto a rotated access token.
  func reauthenticate(accessToken: String) async
  /// A live query. The stream ends when the consumer stops iterating, which unsubscribes.
  func subscribe(_ request: SubscriptionRequest) async -> AsyncStream<DataUpdate>
  /// Every event from now on; each call returns an independent stream.
  func events() async -> AsyncStream<RealtimeEvent>
  var connectionState: RealtimeConnectionState { get async }
}

extension RealtimeClient {
  public func subscribe(
    collection: String, query: JSONObject, fields: JSONObject, fetchInitialData: Bool = true
  ) async -> AsyncStream<DataUpdate> {
    await subscribe(
      SubscriptionRequest(collectionName: collection, query: query, fields: fields, fetchInitialData: fetchInitialData))
  }

  public var isConnected: Bool {
    get async { await connectionState == .connected }
  }
}

/// Native client for the production realtime protocol (AWS API Gateway WebSocket, JSON text frames
/// routed by `action`). Server counterparts: apps/client/server/websocket/* and the action schemas in
/// b4m-core/common/src/schemas/actions.ts; the web client is apps/client/app/contexts/WebsocketContext.tsx.
///
/// - Every connect mints a fresh single-use ticket and connects with `?ticket=`.
/// - Heartbeat every 15s; the server answers with the bare text `pong`. Sixty seconds without any frame
///   closes the socket and reconnects.
/// - Unexpected closes are normal (the gateway caps connection lifetime): reconnect with backoff, then
///   re-send every subscription and emit `.refetchNeeded`.
/// - On token rotation send `reauth_connection`; the server drops all subscriptions and answers
///   `resubscribe_required`, upon which every subscription is re-sent.
public actor WSClient: RealtimeClient {
  public struct Timing: Sendable {
    public var heartbeatInterval: Duration = .seconds(15)
    /// Silence longer than this means the socket is dead even if the OS has not noticed.
    public var receiveTimeout: TimeInterval = 60

    public init() {}
  }

  private let handshake: any RealtimeHandshaking
  private let connector: any WebSocketConnecting
  private let backoff: ReconnectBackoff
  private let timing: Timing
  private let now: @Sendable () -> Date
  private let sleep: @Sendable (Duration) async throws -> Void
  private let tokenRotations: (@Sendable () async -> AsyncStream<String>)?
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "realtime")

  public private(set) var connectionState: RealtimeConnectionState = .idle

  private var lifecycleTask: Task<Void, Never>?
  private var rotationTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var connection: (any WebSocketConnection)?
  /// Distinguishes the current socket from one being torn down, so a late callback cannot act on it.
  private var connectionGeneration = 0
  private var hasConnectedBefore = false
  private(set) var lastReceivedAt = Date.distantPast
  private var cachedURL: URL?
  private var reassembler = ChunkReassembler()
  var pendingChunkCount: Int { reassembler.pendingCount }
  private var subscriptions:
    [String: (request: SubscriptionRequest, continuation: AsyncStream<DataUpdate>.Continuation)] =
      [:]
  private var eventContinuations: [UUID: AsyncStream<RealtimeEvent>.Continuation] = [:]

  /// - Parameter tokenRotations: a source of newly minted access tokens (`AuthController.accessTokenRotations`);
  ///   each one is forwarded with `reauth_connection`.
  public init(
    handshake: any RealtimeHandshaking,
    connector: any WebSocketConnecting = URLSessionWebSocketConnector(),
    backoff: ReconnectBackoff = ReconnectBackoff(),
    timing: Timing = Timing(),
    tokenRotations: (@Sendable () async -> AsyncStream<String>)? = nil,
    now: @escaping @Sendable () -> Date = Date.init,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.handshake = handshake
    self.connector = connector
    self.backoff = backoff
    self.timing = timing
    self.tokenRotations = tokenRotations
    self.now = now
    self.sleep = sleep
  }

  // MARK: - Lifecycle

  public func start() {
    guard lifecycleTask == nil else { return }
    startLifecycle()
    if rotationTask == nil, let tokenRotations {
      rotationTask = Task { [weak self] in
        for await token in await tokenRotations() {
          await self?.reauthenticate(accessToken: token)
        }
      }
    }
  }

  public func stop() {
    lifecycleTask?.cancel()
    lifecycleTask = nil
    rotationTask?.cancel()
    rotationTask = nil
    tearDownConnection()
    hasConnectedBefore = false
    setState(.idle)
  }

  public func resume() {
    guard connectionState == .suspended else { return }
    lifecycleTask = nil
    startLifecycle()
  }

  private func startLifecycle() {
    lifecycleTask = Task { [weak self] in
      await self?.runLifecycle()
    }
  }

  /// Connect, serve the socket until it closes, back off, repeat. Exits on cancellation, on a dead
  /// session, or when attempts run out.
  private func runLifecycle() async {
    var attempt = 0
    while !Task.isCancelled {
      setState(.connecting(attempt: attempt))
      do {
        let connection = try await openConnection()
        attempt = 0
        await serve(connection)
      } catch APIError.signedOut {
        logger.notice("Realtime stopped: the session ended")
        setState(.idle)
        lifecycleTask = nil
        return
      } catch {
        if Task.isCancelled { return }
        // The endpoint may have moved (a redeploy); look it up again on the next attempt.
        cachedURL = nil
        logger.notice("Realtime connect failed: \(String(describing: error), privacy: .public)")
      }
      if Task.isCancelled { return }

      guard let delay = backoff.delay(forAttempt: attempt) else {
        setState(.suspended)
        return
      }
      setState(.waitingToReconnect(attempt: attempt))
      do {
        try await sleep(delay)
      } catch {
        return
      }
      attempt += 1
    }
  }

  private func openConnection() async throws -> any WebSocketConnection {
    let url: URL
    if let cachedURL {
      url = cachedURL
    } else {
      url = try await handshake.websocketURL()
      cachedURL = url
    }
    let ticket = try await handshake.mintTicket()
    try Task.checkCancellation()
    return try await connector.connect(to: url.appendingTicket(ticket))
  }

  /// Runs one socket until it closes. Returns normally on any close: the caller decides whether to retry.
  private func serve(_ socket: any WebSocketConnection) async {
    guard !Task.isCancelled else {
      socket.close()
      return
    }
    connectionGeneration += 1
    let generation = connectionGeneration
    connection = socket
    lastReceivedAt = now()
    setState(.connected)

    for subscription in subscriptions.values {
      await send(.subscribe(subscription.request), on: socket)
    }
    if hasConnectedBefore { emit(.refetchNeeded) }
    hasConnectedBefore = true
    startHeartbeat(generation: generation)

    while !Task.isCancelled {
      do {
        let text = try await socket.receive()
        guard generation == connectionGeneration else { break }
        await handle(text)
      } catch {
        break
      }
    }

    if generation == connectionGeneration { tearDownConnection() }
  }

  private func tearDownConnection() {
    heartbeatTask?.cancel()
    heartbeatTask = nil
    connection?.close()
    connection = nil
    connectionGeneration += 1
  }

  // MARK: - Heartbeat

  private func startHeartbeat(generation: Int) {
    heartbeatTask?.cancel()
    let interval = timing.heartbeatInterval
    let sleep = self.sleep
    heartbeatTask = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await sleep(interval)
        } catch {
          return
        }
        guard let self, await self.heartbeatTick(generation: generation) else { return }
      }
    }
  }

  /// One heartbeat: give up on a silent socket, otherwise ping. Returns `false` once the socket is gone.
  @discardableResult
  func heartbeatTick(generation: Int? = nil) async -> Bool {
    guard let socket = connection, generation == nil || generation == connectionGeneration else { return false }
    let tickTime = now()
    reassembler.purgeExpired(at: tickTime)
    if tickTime.timeIntervalSince(lastReceivedAt) >= timing.receiveTimeout {
      logger.notice("Realtime socket silent past the timeout; reconnecting")
      // Closing makes the pending receive throw, which ends `serve` and starts a reconnect.
      socket.close()
      return false
    }
    await send(.heartbeat, on: socket)
    return true
  }

  // MARK: - Inbound

  private func handle(_ text: String) async {
    lastReceivedAt = now()
    switch InboundFrame.parse(text) {
    case .chunk(let chunk):
      switch reassembler.accept(chunk, at: lastReceivedAt) {
      case .complete(let json):
        guard let object = JSONValue.parse(json)?.objectValue else {
          logger.notice("Dropped a reassembled frame that is not a JSON object")
          return
        }
        let frame = InboundFrame.parse(object)
        if case .chunk = frame { return }
        await route(frame)
      case .pending:
        return
      case .dropped(let reason):
        logger.notice("Dropped a chunked frame: \(String(describing: reason), privacy: .public)")
      }
    case let frame:
      await route(frame)
    }
  }

  private func route(_ frame: InboundFrame) async {
    switch frame {
    case .dataUpdate(let update):
      subscriptions[update.subscriptionID]?.continuation.yield(update)
    case .subscribeError(let id, let message):
      emit(.subscriptionFailed(subscriptionID: id, message: message))
    case .resubscribeRequired:
      guard let socket = connection else { return }
      for request in subscriptions.values.map(\.request) {
        await send(.subscribe(request), on: socket)
      }
    case .action(let action):
      emit(.frame(action))
    case .pong, .ignored, .chunk:
      return
    }
  }

  // MARK: - Outbound

  public func reauthenticate(accessToken: String) async {
    guard let socket = connection else { return }
    await send(.reauthenticate(accessToken: accessToken), on: socket)
  }

  public func subscribe(_ request: SubscriptionRequest) async -> AsyncStream<DataUpdate> {
    let (stream, continuation) = AsyncStream<DataUpdate>.makeStream(bufferingPolicy: .bufferingNewest(500))
    let id = request.subscriptionID
    continuation.onTermination = { [weak self] _ in
      Task { await self?.unsubscribe(id) }
    }
    subscriptions[id] = (request, continuation)
    if let socket = connection {
      await send(.subscribe(request), on: socket)
    }
    return stream
  }

  private func unsubscribe(_ id: String) async {
    guard subscriptions.removeValue(forKey: id) != nil, let socket = connection else { return }
    await send(.unsubscribe(subscriptionID: id), on: socket)
  }

  public func events() -> AsyncStream<RealtimeEvent> {
    let (stream, continuation) = AsyncStream<RealtimeEvent>.makeStream(bufferingPolicy: .bufferingNewest(500))
    let id = UUID()
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeEventContinuation(id) }
    }
    eventContinuations[id] = continuation
    return stream
  }

  private func removeEventContinuation(_ id: UUID) {
    eventContinuations[id] = nil
  }

  private func send(_ frame: OutboundFrame, on socket: any WebSocketConnection) async {
    do {
      try await socket.send(text: frame.text)
    } catch {
      // A failed send means the socket is dying; the receive loop will notice and reconnect, and the
      // reconnect re-sends subscriptions, so nothing is retried here.
      logger.notice("Realtime send failed: \(String(describing: error), privacy: .public)")
    }
  }

  private func emit(_ event: RealtimeEvent) {
    for continuation in eventContinuations.values { continuation.yield(event) }
  }

  private func setState(_ state: RealtimeConnectionState) {
    guard state != connectionState else { return }
    connectionState = state
    emit(.connectionChanged(state))
  }
}
