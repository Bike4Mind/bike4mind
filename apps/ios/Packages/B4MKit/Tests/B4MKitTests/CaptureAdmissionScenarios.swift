import Foundation
import os

@testable import B4MKit

private enum CheckFailure: Error { case failed(String) }
private func trace(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
private func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw CheckFailure.failed(message) }
}

private actor Rendezvous {
  private var entered = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var release: CheckedContinuation<Void, Never>?
  func pause() async {
    entered = true
    waiters.forEach { $0.resume() }
    waiters = []
    await withCheckedContinuation { release = $0 }
  }
  func waitForEntry() async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !entered {
      guard ContinuousClock.now < deadline else {
        throw CheckFailure.failed("Expected request did not enter its held transport")
      }
      try await Task.sleep(for: .milliseconds(10))
    }
  }
  func finish() { release?.resume(); release = nil }
}

private struct NoBiometrics: BiometricGate {
  func canEvaluate() -> Bool { false }
  func evaluate(reason: String) async -> Bool { false }
}

@MainActor struct Approval: WebAuthenticating {
  func authenticate(url: URL, callbackURL: URL) async throws -> URL {
    let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value
    var callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)!
    callback.queryItems = [.init(name: "code", value: "fixture"), .init(name: "state", value: state)]
    return callback.url!
  }
}

private actor FixtureTransport: HTTPTransport {
  struct Claims: Encodable { let id: String; let exp: Int }
  struct Grant: Encodable {
    let accessToken: String
    let refreshToken: String

    enum CodingKeys: String, CodingKey {
      case accessToken = "access_token"
      case refreshToken = "refresh_token"
    }
  }
  struct Refresh: Encodable { let accessToken: String; let refreshToken: String }
  struct Ticket: Encodable { let id: String; let uploadUrl: String; let uploadUrlExpiresAt: String }
  let refresh = Rendezvous()
  let ticket = Rendezvous()
  private var userID: String
  private var holdRefresh = false
  private var holdNextTicket = false
  private var ticketCount = 0
  private(set) var refreshCalls = 0
  private(set) var grantCalls = 0
  init(userID: String) { self.userID = userID }
  func setUser(_ value: String) { userID = value }
  func pauseRefresh() { holdRefresh = true }
  func pauseNextTicket() { holdNextTicket = true }
  private func token() throws -> String {
    let claims = try JSONEncoder().encode(Claims(id: userID, exp: Int(Date().timeIntervalSince1970) + 3600))
    let payload = claims.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
    return "eyJhbGciOiJIUzI1NiJ9.\(payload).fixture"
  }
  private func reply<Value: Encodable>(
    _ value: Value, request: URLRequest, status: Int = 200
  ) throws -> (Data, HTTPURLResponse) {
    (
      try JSONEncoder().encode(value),
      HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    )
  }
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    switch request.url?.path {
    case "/api/oauth/token":
      grantCalls += 1
      return try reply(Grant(accessToken: token(), refreshToken: "fixture-\(userID)"), request: request)
    case "/api/auth/refreshToken":
      refreshCalls += 1
      if holdRefresh { await refresh.pause(); throw URLError(.notConnectedToInternet) }
      return try reply(Refresh(accessToken: token(), refreshToken: "rotated-\(userID)"), request: request)
    case "/api/logout":
      return (Data(), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    case "/api/v1/files" where request.httpMethod == "POST":
      ticketCount += 1
      let id = "file-\(ticketCount)"
      if holdNextTicket { holdNextTicket = false; await ticket.pause() }
      return try reply(
        Ticket(id: id, uploadUrl: "https://uploads.example.test/fixture", uploadUrlExpiresAt: "2030-01-01T00:00:00Z"),
        request: request, status: 201)
    default: throw URLError(.notConnectedToInternet)
    }
  }
}

private final class RecordedUploader: BackgroundUploading, Sendable {
  let identifier = BackgroundSessionIdentifier.app
  private let started = OSAllocatedUnfairLock(initialState: [UUID]())
  func start(jobID: UUID, file: URL, to url: URL, contentType: String) async throws -> Int {
    started.withLock {
      $0.append(jobID); return $0.count
    }
  }
  func liveJobIDs() async -> Set<UUID> { started.withLock { Set($0) } }
  func events() -> AsyncStream<UploadEvent> { AsyncStream { $0.finish() } }
  func starts() -> [UUID] { started.withLock { $0 } }
}

private func waitForSignal(_ semaphore: DispatchSemaphore, seconds: Double = 5) async -> Bool {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async {
      continuation.resume(returning: semaphore.wait(timeout: .now() + seconds) == .success)
    }
  }
}

private final class HeldStagingStore: UploadJobStore, CaptureStagingProviding, Sendable {
  let backing: FileUploadJobStore
  let failAttemptReadback: Bool
  private let unreadable = OSAllocatedUnfairLock(initialState: false)
  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  let written = DispatchSemaphore(value: 0)
  let finish = DispatchSemaphore(value: 0)
  init(directory: URL, failAttemptReadback: Bool = false) {
    backing = FileUploadJobStore(directory: directory)
    self.failAttemptReadback = failAttemptReadback
  }
  func acquireCaptureStagingLease() throws -> SharedSessionFileLease { try backing.acquireCaptureStagingLease() }
  func loadAll() throws -> [UploadJob] { try backing.loadAll() }
  func load(id: UUID) throws -> UploadJob? {
    if unreadable.withLock({ value in
      let result = value; value = false; return result
    }) {
      throw CheckFailure.failed("Injected attempt readback failure")
    }
    return try backing.load(id: id)
  }
  func save(_ job: UploadJob) throws {
    try backing.save(job)
    if failAttemptReadback && job.sendAttemptID != nil { unreadable.withLock { $0 = true } }
  }
  func remove(id: UUID) throws { try backing.remove(id: id) }
  func removeAll() throws { try backing.removeAll() }
  func payloadURL(jobID: UUID, fileName: String) -> URL { backing.payloadURL(jobID: jobID, fileName: fileName) }
  func stagePayload(copying source: URL, jobID: UUID, fileName: String) throws -> URL {
    entered.signal()
    guard release.wait(timeout: .now() + 5) == .success else { throw CheckFailure.failed("Staging release timed out") }
    let result = try backing.stagePayload(copying: source, jobID: jobID, fileName: fileName)
    written.signal()
    guard finish.wait(timeout: .now() + 5) == .success else {
      throw CheckFailure.failed("Staging completion timed out")
    }
    return result
  }
  func writePayload(_ data: Data, jobID: UUID, fileName: String) throws -> URL {
    try backing.writePayload(data, jobID: jobID, fileName: fileName)
  }
  func discardPayload(jobID: UUID) { backing.discardPayload(jobID: jobID) }
}

private actor MultiGate {
  private var entries = 0
  private var released = false
  private var continuations: [CheckedContinuation<Void, Never>] = []
  func pause() async {
    entries += 1
    if released { return }
    await withCheckedContinuation { continuations.append($0) }
  }
  func waitForEntries(_ count: Int) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while entries < count {
      guard ContinuousClock.now < deadline else { throw CheckFailure.failed("Expected API entry did not arrive") }
      try await Task.sleep(for: .milliseconds(10))
    }
  }
  func finish() {
    released = true
    continuations.forEach { $0.resume() }
    continuations = []
  }
}

private actor LocalCaptureAPI: CaptureAPI {
  let lookupGate: MultiGate?
  let sendGate: MultiGate?
  private(set) var sends = 0
  var scanGate: MultiGate?
  var scanFails = false
  var lookup: SentTurnLookup = .notFound
  var sendFails = false
  func configure(
    scanGate: MultiGate? = nil, scanFails: Bool = false, lookup: SentTurnLookup = .notFound, sendFails: Bool = false
  ) {
    self.scanGate = scanGate
    self.scanFails = scanFails
    self.lookup = lookup
    self.sendFails = sendFails
  }
  init(lookupGate: MultiGate? = nil, sendGate: MultiGate? = nil) {
    self.lookupGate = lookupGate
    self.sendGate = sendGate
  }
  func createUpload(fileName: String, mimeType: String, byteCount: Int) async throws -> UploadTicket {
    UploadTicket(
      fileID: "fixture-file", uploadURL: URL(string: "https://uploads.example.test/fixture")!, expiresAt: .distantFuture
    )
  }
  func fileStatus(fileID: String) async throws -> RemoteFileStatus {
    await scanGate?.pause()
    if scanFails { throw APIError.offline }
    return .clean
  }
  func setNotes(fileID: String, notes: String) async throws {}
  func listLakes(cursor: String?, limit: Int) async throws -> Page<LakeSummary> { throw APIError.offline }
  func addFileToLake(lakeID: String, fileID: String) async throws {}
  func sendSessionMessage(sessionID: String, message: String, fileIDs: [String]) async throws {
    sends += 1
    await sendGate?.pause()
    if sendFails { throw APIError.offline }
  }
  func findSentTurn(sessionID: String, message: String, sentAfter: Date) async throws -> SentTurnLookup {
    await lookupGate?.pause()
    return lookup
  }
}

private enum CleanupFailurePoint: String, Sendable {
  case marker, cleanup, refreshClear, recordClear, enumeration, jsonRemoval, refreshRead
}

private final class FaultSessionStore: SharedSessionStorage {
  let contents: InMemoryTokenStore
  private let failure = OSAllocatedUnfairLock<CleanupFailurePoint?>(initialState: nil)
  init(refreshToken: String? = nil) { contents = InMemoryTokenStore(refreshToken: refreshToken) }
  func fail(at point: CleanupFailurePoint?) { failure.withLock { $0 = point } }
  func isFailing(_ point: CleanupFailurePoint) -> Bool { failure.withLock { $0 == point } }
  func refreshToken() throws -> String? {
    if isFailing(.refreshRead) { throw CheckFailure.failed("Injected refresh read failure") }
    return try contents.refreshToken()
  }
  func setRefreshToken(_ token: String?) throws {
    if token == nil && isFailing(.refreshClear) { throw CheckFailure.failed("Injected refresh clear failure") }
    try contents.setRefreshToken(token)
  }
  func sharedSessionRecord() throws -> Data? { try contents.sharedSessionRecord() }
  func setSharedSessionRecord(_ data: Data?) throws {
    if data == nil && isFailing(.recordClear) { throw CheckFailure.failed("Injected sidecar clear failure") }
    if isFailing(.marker), let data,
      let record = try? JSONDecoder().decode(SharedSessionRecord.self, from: data), record.pendingTermination != nil
    {
      throw CheckFailure.failed("Injected pending marker failure")
    }
    try contents.setSharedSessionRecord(data)
  }
  func pendingRevocations() throws -> [PendingRevocation] { try contents.pendingRevocations() }
  func setPendingRevocations(_ values: [PendingRevocation]) throws { try contents.setPendingRevocations(values) }
  func withSharedSessionLock<Result>(_ operation: () throws -> Result) throws -> Result {
    try contents.withSharedSessionLock(operation)
  }
}

@MainActor
enum CaptureAdmissionScenarios {
  static let a = "0123456789abcdef01234567"
  static let b = "1123456789abcdef01234567"
  private static func controller(
    _ store: any TokenStore, _ transport: FixtureTransport, environment: ServerEnvironment = .production,
    cleanup: @escaping @Sendable (SessionTermination) throws -> Void = { _ in }
  ) -> AuthController {
    AuthController(
      environment: environment, tokenStore: store, sessionEndCleanup: cleanup, transport: transport,
      biometricGate: NoBiometrics(), preferences: UserDefaults(suiteName: "capture-live-\(UUID())")!,
      deviceName: { nil })
  }
  private static func file(in directory: URL, name: String) throws -> ShareItem {
    let bytes = Data("fixture photo payload".utf8)
    let url = directory.appending(path: name)
    try bytes.write(to: url)
    return .image(SharedFile(fileURL: url, fileName: name, mimeType: "image/png", byteCount: bytes.count))
  }
  private static func stack(
    auth: AuthController, transport: FixtureTransport, directory: URL, destination: InMemoryDestinationStore,
    uploader: RecordedUploader
  ) -> CaptureStack {
    .live(
      baseURL: ServerEnvironment.production.baseURL, tokens: auth, ownIdentifier: BackgroundSessionIdentifier.app,
      directory: directory, destinationStore: destination, transport: transport, makeUploader: { _ in uploader })
  }
  static func coldOffline() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-live-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let online = FixtureTransport(userID: a)
    let first = controller(storage, online)
    first.restore()
    try await first.signIn(using: Approval())
    let offline = FixtureTransport(userID: a)
    await offline.pauseRefresh()
    let auth = controller(storage, offline)
    auth.restore()
    let uploader = RecordedUploader()
    let capture = stack(
      auth: auth, transport: offline, directory: directory, destination: InMemoryDestinationStore(), uploader: uploader)
    let item = try file(in: directory, name: "cold.png")
    let submission = Task { try await capture.submitter.submit([item], to: .lake(id: "lake-A", name: "A"), note: nil) }
    try await offline.refresh.waitForEntry()
    let queued = try FileUploadJobStore(directory: directory).loadAll()
    await offline.refresh.finish()
    _ = try await submission.value
    try require(
      queued.count == 1 && queued[0].owner?.userID == a,
      "Cold offline queue was not durable before bearer refresh completed")
    try require(
      queued[0].stage == .queued && uploader.starts().isEmpty, "Cold offline submission advanced before it had a bearer"
    )
    try require(
      try FileUploadJobStore(directory: directory).loadAll().count == 1, "Offline failure lost its durable job")
  }
  static func oldComposer(sameUser: Bool) async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-live-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    try await auth.signIn(using: Approval())
    let uploader = RecordedUploader()
    let destination = InMemoryDestinationStore()
    let capture = stack(
      auth: auth, transport: transport, directory: directory, destination: destination, uploader: uploader)
    let composerA = capture.composerModel(items: [try file(in: directory, name: "a.png")])
    await composerA.load()
    composerA.choose(.lake(id: "lake-A", name: "A"))
    await transport.pauseNextTicket()
    let submission = Task { await composerA.submit() }
    try await transport.ticket.waitForEntry()
    let first = try FileUploadJobStore(directory: directory).loadAll()
    guard let original = first.first else { throw CheckFailure.failed("A was not enqueued") }
    await auth.signOut(reason: .sessionEnded)
    await transport.setUser(sameUser ? a : b)
    try await auth.signIn(using: Approval())
    let composerB = capture.composerModel(items: [try file(in: directory, name: "b.png")])
    await composerB.load()
    composerB.choose(.lake(id: "lake-B", name: "B"))
    await composerB.submit()
    let before = try FileUploadJobStore(directory: directory).loadAll()
    guard let bJob = before.first(where: { $0.id != original.id }) else {
      throw CheckFailure.failed("B was not enqueued")
    }
    let bPayload = FileUploadJobStore(directory: directory).payloadURL(jobID: bJob.id, fileName: "b.png")
    let expectedPayload = try Data(contentsOf: bPayload)
    await transport.ticket.finish()
    await submission.value
    let after = try FileUploadJobStore(directory: directory).loadAll()
    var failures: [String] = []
    if uploader.starts().contains(original.id) { failures.append("stale A work started an upload") }
    if !sameUser && after.contains(where: { $0.owner?.userID == a }) {
      failures.append("stale A work resurrected a removed row")
    }
    if sameUser && after.first(where: { $0.id == original.id })?.stage != .queued {
      failures.append("old incarnation mutated its retained job")
    }
    if destination.lastDestination() != .lake(id: "lake-B", name: "B") {
      failures.append("stale composer overwrote B destination")
    }
    if !after.contains(where: { $0.id == bJob.id }) || (try? Data(contentsOf: bPayload)) != expectedPayload {
      failures.append("B job or payload changed")
    }
    try require(failures.isEmpty, failures.joined(separator: "; "))
  }
  static func destinationBinding() async throws {
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    try await auth.signIn(using: Approval())
    let targetA = CaptureDestination.lake(id: "lake-A", name: "A")
    let targetB = CaptureDestination.lake(id: "lake-B", name: "B")
    let destination = InMemoryDestinationStore(targetA)
    let bound = AdmittedDestinationStore(store: destination, admission: .success(try auth.captureAdmission()))
    try require(bound.lastDestination() == targetA, "Current producer could not read its destination")
    await auth.signOut(reason: .sessionEnded)
    await transport.setUser(b)
    try await auth.signIn(using: Approval())
    destination.remember(targetB)
    bound.remember(targetA)
    bound.forget()
    try require(destination.lastDestination() == targetB, "Old destination capability changed B's choice")
    try require(bound.lastDestination() == nil, "Old producer read B's destination")
  }

  static func endingWaitsForPayloadStaging() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-staging-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    try await auth.signIn(using: Approval())
    let admission = try auth.captureAdmission()
    let store = HeldStagingStore(directory: directory)
    defer { store.release.signal(); store.finish.signal() }
    let api = LocalCaptureAPI()
    let uploader = RecordedUploader()
    let engine = CaptureEngine(
      store: store, api: api, ownIdentifier: BackgroundSessionIdentifier.app, makeUploader: { _ in uploader },
      currentAdmission: { try await auth.captureAdmission() }, makeAdmittedAPI: { _ in api })
    let item = try file(in: directory, name: "held.png")
    let submission = Task { try await engine.submit([item], to: .lake(id: "lake-A", name: "A"), note: nil) }
    try require(await waitForSignal(store.entered), "Payload staging did not enter")
    let cleanup = CaptureSessionCleanup(directory: directory, destinations: InMemoryDestinationStore())
    let cleanupEntered = DispatchSemaphore(value: 0)
    let ended = DispatchSemaphore(value: 0)
    let coordinator = SharedSessionCoordinator(tokenStore: storage, baseURL: ServerEnvironment.production.baseURL)!
    let ending = Task.detached {
      let result = try coordinator.end(incarnation: admission.identity.incarnation, reason: .userInitiated) { target in
        cleanupEntered.signal()
        try cleanup.perform(target)
      }
      ended.signal()
      return result
    }
    try require(await waitForSignal(cleanupEntered), "End cleanup did not enter")
    let endedBeforeCopy = await waitForSignal(ended, seconds: 0.1)
    store.release.signal()
    try require(await waitForSignal(store.written), "Held writer did not write its payload")
    let paths = directory.appending(path: "Capture/payloads")
    let bytesPresent = !((try? FileManager.default.contentsOfDirectory(atPath: paths.path())) ?? []).isEmpty
    store.finish.signal()
    _ = await submission.result
    let completed = try await ending.value
    trace("ORDER endedBeforeCopy=\(endedBeforeCopy) bytesBeforeMetadata=\(bytesPresent)")
    try require(completed, "Original ending session was not cleared")
    try require(!endedBeforeCopy, "Session end completed before an admitted payload writer drained")
    try require(try store.loadAll().isEmpty, "Ended writer published a capture record")
    try require(
      ((try? FileManager.default.contentsOfDirectory(atPath: paths.path())) ?? []).isEmpty,
      "Staged payload survived completed end cleanup")
  }

  static func sameSecondAttemptClaim() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-attempt-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    try await auth.signIn(using: Approval())
    let admission = try auth.captureAdmission()
    let store = FileUploadJobStore(directory: directory)
    let wholeSecond = Date(timeIntervalSince1970: 1_800_000_000)
    var job = UploadJob(
      destination: .session(id: "session-A", name: "A"), payload: .message("same-second fixture"), note: nil,
      now: wholeSecond, owner: CaptureOwner(userID: admission.identity.userID, baseURL: admission.identity.baseURL))
    job.stage = .registering
    job.sendAttemptedAt = wholeSecond
    try store.save(job)
    let lookupGate = MultiGate()
    let sendGate = MultiGate()
    let api = LocalCaptureAPI(lookupGate: lookupGate, sendGate: sendGate)
    let uploader = RecordedUploader()
    let fractionalNow = wholeSecond.addingTimeInterval(0.456)
    func makeEngine() -> CaptureEngine {
      CaptureEngine(
        store: store, api: api, ownIdentifier: BackgroundSessionIdentifier.app, makeUploader: { _ in uploader },
        now: { fractionalNow }, sleep: { _ in },
        currentAdmission: { try await auth.captureAdmission() }, makeAdmittedAPI: { _ in api })
    }
    let firstEngine = makeEngine()
    let secondEngine = makeEngine()
    let finished = DispatchSemaphore(value: 0)
    let first = Task {
      await firstEngine.resume(); finished.signal()
    }
    let second = Task {
      await secondEngine.resume(); finished.signal()
    }
    try await lookupGate.waitForEntries(2)
    await lookupGate.finish()
    try await sendGate.waitForEntries(1)
    let losingWriterStopped = await waitForSignal(finished, seconds: 1)
    let sendsBeforeCompletion = await api.sends
    await sendGate.finish()
    await first.value
    await second.value
    trace("CLAIM sameSecondDirectSends=\(sendsBeforeCompletion) loserStopped=\(losingWriterStopped)")
    try require(
      losingWriterStopped && sendsBeforeCompletion == 1,
      "Identical same-second attempt writes both permitted a direct POST")
    try require(
      try store.load(id: job.id)?.stage == .done, "Winning attempt did not complete against canonical saved dates")
  }

  static func cleanupFailureRecovery() async throws {
    for point: CleanupFailurePoint in [.marker, .cleanup, .refreshClear, .recordClear, .enumeration, .jsonRemoval] {
      trace("FAULT \(point.rawValue)")
      try await cleanupFailureRecovery(at: point)
      trace("RECOVERED \(point.rawValue)")
    }
  }

  private static func cleanupFailureRecovery(at point: CleanupFailurePoint) async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-cleanup-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let jobsDirectory = directory.appending(path: "Capture/jobs")
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: jobsDirectory.path())
      try? FileManager.default.removeItem(at: directory)
    }
    let storage = FaultSessionStore()
    let transport = FixtureTransport(userID: a)
    let destinations = InMemoryDestinationStore(.lake(id: "lake-A", name: "A"))
    let cleanup = CaptureSessionCleanup(directory: directory, destinations: destinations)
    let targets = OSAllocatedUnfairLock(initialState: [SessionTermination]())
    let perform: @Sendable (SessionTermination) throws -> Void = { target in
      targets.withLock { $0.append(target) }
      if storage.isFailing(.cleanup) { throw CheckFailure.failed("Injected cleanup failure") }
      try cleanup.perform(target)
    }
    let auth = controller(storage, transport, cleanup: perform)
    auth.restore()
    try await auth.signIn(using: Approval())
    let original = try auth.captureAdmission().identity
    let store = FileUploadJobStore(directory: directory)
    let now = Date()
    let jobA = UploadJob(
      destination: .lake(id: "lake-A", name: "A"), payload: .file(name: "a.png", mimeType: "image/png", byteCount: 1),
      note: nil, now: now, owner: CaptureOwner(userID: a, baseURL: original.baseURL))
    let jobB = UploadJob(
      destination: .lake(id: "lake-B", name: "B"), payload: .file(name: "b.png", mimeType: "image/png", byteCount: 1),
      note: nil, now: now, owner: CaptureOwner(userID: b, baseURL: original.baseURL))
    _ = try store.writePayload(Data([1]), jobID: jobA.id, fileName: "a.png")
    _ = try store.writePayload(Data([2]), jobID: jobB.id, fileName: "b.png")
    try store.save(jobA)
    try store.save(jobB)
    storage.fail(at: point)
    if point == .enumeration || point == .jsonRemoval {
      let permissions = point == .enumeration ? 0o100 : 0o500
      try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: jobsDirectory.path())
    }
    let ended = await auth.signOut()
    try require(!ended && auth.state == .restoring, "\(point.rawValue) falsely completed sign-out")
    try require((try? auth.captureAdmission()) == nil, "\(point.rawValue) kept capture admission usable")
    try require(try storage.pendingRevocations().count == 1, "Deferred local end lost its captured remote revocation")
    if point == .recordClear {
      try require(try storage.contents.refreshToken() == nil, "Record-clear control did not clear refresh first")
      try require(try storage.sharedSessionRecord() != nil, "Partial clear lost its recovery marker")
    }
    let recovering: AuthController
    if point == .marker {
      // A marker that never reached durable storage is retried by the controller holding that local intent.
      recovering = auth
    } else {
      recovering = controller(
        storage, transport, environment: .custom(URL(string: "https://other.example.test")!), cleanup: perform)
      recovering.restore()
      try require(recovering.state == .restoring, "Restart treated incomplete cleanup as signed out")
    }
    let grantsBefore = await transport.grantCalls
    var refused = false
    do { try await recovering.signIn(using: Approval()) } catch { refused = true }
    let grantsAfter = await transport.grantCalls
    try require(refused && grantsBefore == grantsAfter, "Pending cleanup allowed a new grant exchange")
    storage.fail(at: nil)
    if point == .enumeration || point == .jsonRemoval {
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: jobsDirectory.path())
    }
    recovering.restore()
    try require(recovering.state == .signedOut(.userInitiated), "Recovery lost the original end reason")
    try require(
      try storage.refreshToken() == nil && storage.sharedSessionRecord() == nil, "Recovery left credential state")
    try require(
      targets.withLock { $0.allSatisfy { $0.identity == original && $0.reason == .userInitiated } },
      "Recovery changed the durable target")
    try require(
      try store.loadAll().map(\.id) == [jobB.id], "Cleanup removed another owner or retained the ending owner")
    try require(
      !FileManager.default.fileExists(atPath: store.payloadURL(jobID: jobA.id, fileName: "a.png").path()),
      "Ending owner payload survived")
    try require(
      try Data(contentsOf: store.payloadURL(jobID: jobB.id, fileName: "b.png")) == Data([2]),
      "Other owner payload changed")
    try require(destinations.lastDestination() == nil, "Ending destination survived recovery")
    let queuedRevocations = try storage.pendingRevocations()
    await recovering.retryPendingRevocations()
    if recovering.environment.baseURL != original.baseURL {
      try require(
        try storage.pendingRevocations() == queuedRevocations, "Another server's retry changed the pending intent")
      await recovering.switchEnvironment(to: .production)
      await recovering.retryPendingRevocations()
    }
    try require(try storage.pendingRevocations().isEmpty, "Captured revocation was not retried on its server")
  }

  static func deferredRestoreCannotReportSignOutSuccess() async throws {
    let storage = FaultSessionStore(refreshToken: "opaque-legacy")
    storage.fail(at: .refreshRead)
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    let ended = await auth.signOut()
    try require(!ended && auth.state == .restoring, "Unreadable legacy session falsely completed sign-out")
    try require(try storage.contents.refreshToken() == "opaque-legacy", "Unreadable control lost its credential")
    try require(try storage.contents.sharedSessionRecord() == nil, "Unreadable control unexpectedly created a sidecar")
    try require(await transport.refreshCalls == 0, "Deferred sign-out touched refresh transport")
  }

  static func staleSignOutScopeCannotEndNewLogin() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-ending-scope-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let destinations = InMemoryDestinationStore()
    let cleanup = CaptureSessionCleanup(directory: directory, destinations: destinations)
    let auth = controller(storage, transport, cleanup: cleanup.perform)
    auth.restore()
    try await auth.signIn(using: Approval())
    let oldScope = try auth.sessionEndScope()
    _ = await auth.signOut(reason: .sessionEnded)
    await transport.setUser(b)
    try await auth.signIn(using: Approval())
    let newIdentity = try auth.captureAdmission().identity
    let destination = CaptureDestination.lake(id: "lake-B", name: "B")
    destinations.remember(destination)
    let store = FileUploadJobStore(directory: directory)
    let job = UploadJob(
      destination: destination, payload: .file(name: "b.png", mimeType: "image/png", byteCount: 1), note: nil,
      now: Date(), owner: CaptureOwner(userID: b, baseURL: newIdentity.baseURL))
    _ = try store.writePayload(Data([2]), jobID: job.id, fileName: "b.png")
    try store.save(job)
    let ended = await auth.signOut(scope: oldScope)
    try require(!ended && auth.state == .signedIn, "Old sign-out scope ended the replacement login")
    try require(try auth.captureAdmission().identity == newIdentity, "Old scope changed current admission")
    try require(try store.load(id: job.id) != nil, "Old scope removed the new owner's record")
    try require(
      try Data(contentsOf: store.payloadURL(jobID: job.id, fileName: "b.png")) == Data([2]),
      "Old scope removed the new owner's bytes")
    try require(destinations.lastDestination() == destination, "Old scope forgot the new owner's destination")
  }

  static func staleScanCannotOverwriteCompletion() async throws {
    for scanFails in [false, true] {
      let directory = FileManager.default.temporaryDirectory.appending(path: "capture-scan-\(UUID())")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let storage = InMemoryTokenStore()
      let transport = FixtureTransport(userID: a)
      let auth = controller(storage, transport)
      auth.restore()
      try await auth.signIn(using: Approval())
      let admission = try auth.captureAdmission()
      let store = FileUploadJobStore(directory: directory)
      var job = UploadJob(
        destination: .session(id: "A", name: "A"),
        payload: .file(name: "photo.png", mimeType: "image/png", byteCount: 1), note: nil,
        now: Date(), owner: CaptureOwner(userID: a, baseURL: admission.identity.baseURL))
      job.stage = .registering
      job.ticket = UploadTicket(
        fileID: "file-A", uploadURL: URL(string: "https://uploads.example.test/A")!, expiresAt: .distantFuture)
      _ = try store.writePayload(Data([1]), jobID: job.id, fileName: "photo.png")
      try store.save(job)
      let gate = MultiGate()
      let oldAPI = LocalCaptureAPI()
      await oldAPI.configure(scanGate: gate, scanFails: scanFails)
      let currentAPI = LocalCaptureAPI()
      let uploader = RecordedUploader()
      func engine(_ api: LocalCaptureAPI) -> CaptureEngine {
        CaptureEngine(
          store: store, api: api, ownIdentifier: BackgroundSessionIdentifier.app,
          makeUploader: { _ in uploader }, sleep: { _ in },
          currentAdmission: { try await auth.captureAdmission() }, makeAdmittedAPI: { _ in api })
      }
      let oldEngine = engine(oldAPI)
      let currentEngine = engine(currentAPI)
      let oldScan = Task { await oldEngine.resume() }
      try await gate.waitForEntries(1)
      await currentEngine.resume()
      let completed = try store.load(id: job.id)
      try require(completed?.stage == .done, "Current engine did not complete the scanned file")
      await gate.finish()
      await oldScan.value
      try require(try store.load(id: job.id) == completed, "Stale scan overwrote the completed row")
      let staleSends = await oldAPI.sends
      try require(staleSends == 0, "Stale scan dispatched another message")
    }
  }

  static func uncertainDeliveryRequiresReconciliation() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-delivery-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    try await auth.signIn(using: Approval())
    let admission = try auth.captureAdmission()
    let store = FileUploadJobStore(directory: directory)
    let api = LocalCaptureAPI()
    let uploader = RecordedUploader()
    let engine = CaptureEngine(
      store: store, api: api, ownIdentifier: BackgroundSessionIdentifier.app,
      makeUploader: { _ in uploader }, sleep: { _ in },
      currentAdmission: { try await auth.captureAdmission() }, makeAdmittedAPI: { _ in api })
    var job = UploadJob(
      destination: .session(id: "A", name: "A"), payload: .message("uncertain"), note: nil,
      now: Date(), owner: CaptureOwner(userID: a, baseURL: admission.identity.baseURL))
    job.stage = .registering
    try store.save(job)
    await api.configure(sendFails: true)
    await engine.resume()
    let attempted = try store.load(id: job.id)
    try require(
      attempted?.stage == .registering && attempted?.sendAttemptID != nil && attempted?.sendAttemptedAt != nil,
      "Interrupted POST lost its durable attempt marker")
    await api.configure(lookup: .found(questID: "accepted-A"))
    await engine.resume()
    let sendsAfterFound = await api.sends
    try require(
      sendsAfterFound == 1 && (try store.load(id: job.id))?.stage == .done,
      "Found delivery was resent")
    var unknown = UploadJob(
      destination: .session(id: "A", name: "A"), payload: .message("unknown"), note: nil,
      now: Date(), owner: job.owner)
    unknown.stage = .registering
    unknown.sendAttemptedAt = Date()
    unknown.sendAttemptID = UUID()
    try store.save(unknown)
    await api.configure(lookup: .inconclusive)
    await engine.resume()
    let failed = try store.load(id: unknown.id)
    try require(
      failed?.stage == .failed && failed?.sendAttemptedAt == nil && failed?.sendAttemptID == nil,
      "Inconclusive delivery did not atomically record explicit-retry state")
    await engine.resume()
    let sendsBeforeRetry = await api.sends
    try require(sendsBeforeRetry == 1, "Inconclusive delivery retried without user action")
    await api.configure()
    await engine.retry(jobID: unknown.id)
    let sendsAfterRetry = await api.sends
    try require(
      sendsAfterRetry == 2 && (try store.load(id: unknown.id))?.stage == .done,
      "Explicit retry did not permit exactly one new attempt")
  }

  static func attemptReadbackFailureCannotDispatch() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "capture-readback-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = InMemoryTokenStore()
    let transport = FixtureTransport(userID: a)
    let auth = controller(storage, transport)
    auth.restore()
    try await auth.signIn(using: Approval())
    let admission = try auth.captureAdmission()
    let store = HeldStagingStore(directory: directory, failAttemptReadback: true)
    let api = LocalCaptureAPI()
    let uploader = RecordedUploader()
    let engine = CaptureEngine(
      store: store, api: api, ownIdentifier: BackgroundSessionIdentifier.app,
      makeUploader: { _ in uploader }, sleep: { _ in },
      currentAdmission: { try await auth.captureAdmission() }, makeAdmittedAPI: { _ in api })
    var job = UploadJob(
      destination: .session(id: "A", name: "A"), payload: .message("readback"), note: nil,
      now: Date(), owner: CaptureOwner(userID: a, baseURL: admission.identity.baseURL))
    job.stage = .registering
    try store.save(job)
    await engine.resume()
    let sends = await api.sends
    let saved = try store.backing.load(id: job.id)
    try require(
      sends == 0 && saved?.sendAttemptID != nil && saved?.stage == .registering,
      "Failed durable-attempt readback permitted a POST or erased the saved marker")
  }

  static func pendingRevocationsMigrateOnceBeforeUse() throws {
    let clock = Date(timeIntervalSince1970: 1_800_000_000)
    let legacy = Data(#"[{"baseURL":"https://legacy.example.test","refreshToken":"legacy"}]"#.utf8)
    var stored = legacy
    let first = try PendingRevocationCodec.load(stored, now: clock) { stored = $0 }
    try require(
      first.count == 1 && first[0].refreshToken == "legacy" && first[0].createdAt == clock,
      "Legacy pending revocation was lost or not timestamped")
    var unexpectedWrites = 0
    let second = try PendingRevocationCodec.load(stored, now: clock.addingTimeInterval(100)) { _ in
      unexpectedWrites += 1
    }
    try require(second == first && unexpectedWrites == 0, "Repeated read reset a pending revocation's age")
    var rejected = false
    do {
      _ = try PendingRevocationCodec.load(legacy, now: clock) { _ in
        throw CheckFailure.failed("Injected migration write failure")
      }
    } catch { rejected = true }
    try require(rejected, "Failed durable migration returned a usable queue")
    let dated = PendingRevocation(
      baseURL: URL(string: "https://dated.example.test")!, refreshToken: "dated",
      createdAt: clock.addingTimeInterval(-100))
    let datedJSON = String(decoding: try JSONEncoder().encode(dated), as: UTF8.self)
    let mixed = Data((String(decoding: legacy.dropLast(), as: UTF8.self) + "," + datedJSON + "]").utf8)
    let migrated = try PendingRevocationCodec.load(mixed, now: clock) { stored = $0 }
    try require(migrated == first + [dated], "Migration changed an already dated record")
    try require(
      PendingRevocation.bounded(migrated, now: clock.addingTimeInterval(PendingRevocation.maxAge)).isEmpty,
      "Migrated records bypassed the existing age cap")
  }

}
