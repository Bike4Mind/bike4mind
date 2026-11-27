import Foundation
import os

/// Drives capture jobs through `UploadStage`. Owned by the app (which finishes everything) and by the share
/// extension (which only starts uploads before it is reaped). All durable state is in the `UploadJobStore`;
/// the engine holds none, so a fresh engine in a relaunched process picks up exactly where the last one
/// stopped.
public actor CaptureEngine {
  public struct Configuration: Sendable {
    /// PUTs attempted before a job is failed.
    public var maxUploadAttempts = 3
    /// Transient failures (5xx, offline, rate limit) tolerated in `registering` before the job is failed.
    public var maxRegisterFailures = 10
    /// How far before `sendAttemptedAt` a server-side turn still counts as this job's, for clock skew.
    public var sendClockSkew: TimeInterval = 5 * 60
    public var pollInterval: Duration = .seconds(2)
    /// Scan polls per `register` pass; a still-scanning file stays `registering` for the next pass.
    public var maxPollsPerPass = 15
    /// How long another session's `uploading` job may stay silent before this process retries it.
    public var foreignUploadStaleAfter: TimeInterval = 30 * 60
    /// Wait before declaring this session's missing tasks lost, so completion events already on their
    /// way are not raced.
    public var reconcileGrace: Duration = .seconds(1)
    public var doneRetention: TimeInterval = 24 * 60 * 60

    public init() {}
  }

  private let store: any UploadJobStore
  private let api: any CaptureAPI
  private let ownIdentifier: String
  private let makeUploader: @Sendable (String) -> any BackgroundUploading
  private let now: @Sendable () -> Date
  private let sleep: @Sendable (Duration) async -> Void
  private let configuration: Configuration
  private let didSendToSession: (@Sendable (String) async -> Void)?
  private let currentOwner: (@Sendable () async -> CaptureOwner?)?
  private let currentAdmission: (@Sendable () async throws -> SharedSessionAdmission)?
  private let makeAdmittedAPI: (@Sendable (SharedSessionAdmission) -> any CaptureAPI)?
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "capture")

  private var uploaders: [String: any BackgroundUploading] = [:]
  private var eventTasks: [String: Task<Void, Never>] = [:]
  private var inFlight: Set<UUID> = []
  /// Jobs wiped by `discardAll()`; a pass still awaiting the network must not write them back.
  private var discarded: Set<UUID> = []
  /// With `currentOwner` set, the account whose jobs this engine sends and lists; `nil` until `claim` runs.
  private var claimedOwner: CaptureOwner?
  private var claimedAdmission: SharedSessionAdmission?
  /// Bumped when ownership ends, so a `claim` suspended on `currentOwner` can tell its answer is stale.
  private var ownershipGeneration = 0
  private var observers: [UUID: AsyncStream<[UploadJob]>.Continuation] = [:]

  /// - Parameters:
  ///   - ownIdentifier: this process's background session (`BackgroundSessionIdentifier.app` or `.shareExtension`).
  ///   - makeUploader: builds the session for an identifier; the app also asks for the extension's.
  ///   - currentOwner: the signed-in account. When set, jobs are stamped with it at enqueue, and only its jobs
  ///     are sent or listed; any other account's (or an unowned) job is discarded first.
  public init(
    store: any UploadJobStore,
    api: any CaptureAPI,
    ownIdentifier: String,
    makeUploader: @escaping @Sendable (String) -> any BackgroundUploading,
    now: @escaping @Sendable () -> Date = Date.init,
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    configuration: Configuration = Configuration(),
    didSendToSession: (@Sendable (String) async -> Void)? = nil,
    currentOwner: (@Sendable () async -> CaptureOwner?)? = nil,
    currentAdmission: (@Sendable () async throws -> SharedSessionAdmission)? = nil,
    makeAdmittedAPI: (@Sendable (SharedSessionAdmission) -> any CaptureAPI)? = nil
  ) {
    self.store = store
    self.api = api
    self.ownIdentifier = ownIdentifier
    self.makeUploader = makeUploader
    self.now = now
    self.sleep = sleep
    self.configuration = configuration
    self.didSendToSession = didSendToSession
    self.currentOwner = currentOwner
    self.currentAdmission = currentAdmission
    self.makeAdmittedAPI = makeAdmittedAPI
  }

  private var hasOwnershipProvider: Bool { currentOwner != nil || currentAdmission != nil }

  private func withCurrentClaim<Result>(_ operation: () throws -> Result) throws -> Result {
    guard currentAdmission != nil else { return try operation() }
    guard let claimedAdmission else { throw CaptureOwnershipError.noSignedInAccount }
    return try claimedAdmission.withCurrent(operation)
  }

  private struct Work: Sendable {
    let generation: Int
    let owner: CaptureOwner?
    let admission: SharedSessionAdmission?
    let api: any CaptureAPI
  }

  private func makeWork() throws -> Work {
    if hasOwnershipProvider && claimedOwner == nil { throw CaptureOwnershipError.noSignedInAccount }
    if currentAdmission != nil {
      guard let admission = claimedAdmission, let makeAdmittedAPI else { throw SharedSessionError.unavailable }
      return Work(generation: ownershipGeneration, owner: claimedOwner, admission: admission, api: makeAdmittedAPI(admission))
    }
    return Work(generation: ownershipGeneration, owner: claimedOwner, admission: nil, api: api)
  }

  private func withWork<Result>(
    _ work: Work, job: UploadJob? = nil, checkState: Bool = false, _ operation: () throws -> Result
  ) throws -> Result {
    guard work.generation == ownershipGeneration, work.owner == claimedOwner,
      work.admission?.identity == claimedAdmission?.identity else { throw SharedSessionError.changed }
    if let job {
      guard !discarded.contains(job.id), !hasOwnershipProvider || job.owner == work.owner else {
        throw SharedSessionError.changed
      }
    }
    func checkRecord() throws {
      if let job {
        guard let current = try self.store.load(id: job.id), current.owner == job.owner else {
          throw SharedSessionError.changed
        }
        if checkState {
          guard current == job else { throw SharedSessionError.changed }
        }
      }
    }
    if let admission = work.admission {
      return try admission.withCurrent {
        try checkRecord()
        return try operation()
      }
    }
    try checkRecord()
    return try operation()
  }

  private func validate(_ work: Work, job: UploadJob? = nil) throws {
    try withWork(work, job: job, checkState: true) {}
  }

  private func jobs(work: Work) throws -> [UploadJob] {
    try withWork(work) {
      let all = try store.loadAll()
      return hasOwnershipProvider ? all.filter { $0.owner == work.owner } : all
    }
  }

  @discardableResult
  private func updateJob(_ id: UUID, work: Work, _ change: (inout UploadJob) throws -> Bool) throws -> Bool {
    defer { notify() }
    return try withWork(work) {
      guard !discarded.contains(id), var job = try store.load(id: id),
        !hasOwnershipProvider || job.owner == work.owner else { return false }
      guard try change(&job) else { return false }
      job.updatedAt = now()
      try store.save(job)
      return true
    }
  }

  // MARK: - Observing

  public func jobs() -> [UploadJob] {
    (try? withCurrentClaim {
      let all = try store.loadAll()
      guard hasOwnershipProvider else { return all }
      guard let claimedOwner else { return [] }
      return all.filter { $0.owner == claimedOwner }
    }) ?? []
  }

  func jobs(admission: SharedSessionAdmission) -> [UploadJob] {
    (try? admission.withCurrent {
      let owner = CaptureOwner(userID: admission.identity.userID, baseURL: admission.identity.baseURL)
      return try store.loadAll().filter { $0.owner == owner }
    }) ?? []
  }

  /// The full job list, now and after every change.
  public func updates() -> AsyncStream<[UploadJob]> {
    let (stream, continuation) = AsyncStream<[UploadJob]>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let id = UUID()
    observers[id] = continuation
    continuation.yield(jobs())
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeObserver(id) }
    }
    return stream
  }

  private func removeObserver(_ id: UUID) {
    observers[id] = nil
  }

  private func notify() {
    guard !observers.isEmpty else { return }
    let snapshot = jobs()
    for continuation in observers.values { continuation.yield(snapshot) }
  }

  // MARK: - Entry points

  /// Persists a job per item. Nothing leaves the device yet; call `start(_:)`/`resume()` for that.
  public func enqueue(_ items: [ShareItem], to destination: CaptureDestination, note: String?) throws -> [UploadJob] {
    try enqueue(items, to: destination, note: note, work: makeWork())
  }

  private func enqueue(_ items: [ShareItem], to destination: CaptureDestination, note: String?, work: Work) throws -> [UploadJob] {
    try validate(work)
    let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    var created: [UploadJob] = []
    var published = Set<UUID>()
    do {
      do {
        // Admission precedes the shared staging lock; release it before metadata takes admission again.
        let stagingLease: SharedSessionFileLease? = try withWork(work) {
          if let staging = store as? any CaptureStagingProviding {
            return try staging.acquireCaptureStagingLease()
          }
          guard currentAdmission == nil else { throw SharedSessionError.unavailable }
          return nil
        }
        defer { stagingLease?.release() }
        for item in items {
          created.append(try makeJob(for: item, destination: destination, note: trimmedNote, owner: work.owner))
        }
      }
      try withWork(work) {
        do {
          for job in created {
            try store.save(job)
            published.insert(job.id)
          }
          created = try created.map { job in
            guard let saved = try store.load(id: job.id), saved.id == job.id, saved.owner == job.owner else {
              throw StoreUnavailable()
            }
            return saved
          }
        } catch {
          for id in published {
            do {
              try store.remove(id: id)
              published.remove(id)
            } catch {
              logger.error("Rolling back capture publication failed: \(error, privacy: .private)")
            }
          }
          throw error
        }
      }
    } catch {
      // A surviving published record keeps its payload; only unpublished staging is ours to undo.
      for job in created where !published.contains(job.id) { store.discardPayload(jobID: job.id) }
      notify()
      throw error
    }
    notify()
    return created
  }

  /// Enqueues, then mints tickets and hands every file to the background session. Returns when the bytes are
  /// in the system's hands (or the first problem), which is as long as the share extension needs to stay alive.
  /// The result has one job per item, in item order.
  @discardableResult
  public func submit(
    _ items: [ShareItem], to destination: CaptureDestination, note: String?
  ) async throws
    -> [UploadJob]
  {
    try await submit(items, to: destination, note: note, expectedAdmission: nil)
  }

  func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?, admission: SharedSessionAdmission)
    async throws -> [UploadJob]
  {
    try await submit(items, to: destination, note: note, expectedAdmission: admission)
  }

  private func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?, expectedAdmission: SharedSessionAdmission?)
    async throws -> [UploadJob]
  {
    if hasOwnershipProvider {
      guard try await claim(expected: expectedAdmission) else { throw CaptureOwnershipError.noSignedInAccount }
    }
    let work = try makeWork()
    try validate(work)
    let jobs = try enqueue(items, to: destination, note: note, work: work)
    for job in jobs {
      try validate(work, job: job)
      await advance(job.id, work: work)
    }
    return try withWork(work) {
      try jobs.map { job in
        guard !discarded.contains(job.id), let saved = try store.load(id: job.id), saved.owner == job.owner else {
          throw CancellationError()
        }
        return saved
      }
    }
  }

  /// App launch / foreground: retry lost uploads, push every unfinished job forward, prune old results.
  public func resume() async {
    do {
      if hasOwnershipProvider { guard try await claim() else { return } }
      let work = try makeWork()
      try prune(work: work)
      var sessionIDs = Set<String>()
      for job in try jobs(work: work) where job.stage == .done {
        if case .session(let sessionID, _) = job.destination { sessionIDs.insert(sessionID) }
      }
      for sessionID in sessionIDs {
        try validate(work)
        await didSendToSession?(sessionID)
        try validate(work)
      }
      try await reconcile(work: work)
      for job in try jobs(work: work) where !job.stage.isTerminal {
        try validate(work)
        await advance(job.id, work: work)
      }
    } catch {
      logger.notice("Capture resume unavailable: \(error, privacy: .private)")
    }
  }

  /// The system relaunched the app to deliver events of a background session (`identifier`).
  public func reattach(identifier: String) {
    _ = uploader(for: identifier)
  }

  /// `handleEventsForBackgroundURLSession`: re-creates the session and hands it the system's completion
  /// handler, which it calls once every pending event has been delivered. Foreign identifiers are acknowledged
  /// immediately so the system is never left waiting.
  public func reattach(identifier: String, systemCompletion: @escaping @Sendable () -> Void) {
    guard BackgroundSessionIdentifier.isCaptureSession(identifier),
      let real = uploader(for: identifier) as? URLSessionBackgroundUploader
    else {
      systemCompletion()
      return
    }
    real.adoptSystemCompletionHandler(systemCompletion)
  }

  public func retry(jobID: UUID) async {
    do { try await retry(jobID: jobID, work: makeWork()) }
    catch { logger.notice("Capture retry unavailable: \(error, privacy: .private)") }
  }

  private func retry(jobID: UUID, work: Work) async throws {
    let changed = try updateJob(jobID, work: work) { job in
      guard job.stage == .failed else { return false }
      job.stage = .queued
      job.ticket = nil
      job.uploadSession = nil
      job.uploadTaskID = nil
      job.uploadAttempts = 0
      job.registerFailures = 0
      job.lastError = nil
      return true
    }
    if changed { await advance(jobID, work: work) }
  }

  func retry(jobID: UUID, admission: SharedSessionAdmission) async {
    do {
      guard try await claim(expected: admission) else { return }
      try await retry(jobID: jobID, work: makeWork())
    } catch { logger.notice("Capture retry admission unavailable: \(error, privacy: .private)") }
  }

  public func discard(jobID: UUID) {
    do { try discard(jobID: jobID, work: makeWork()) }
    catch { logger.notice("Capture discard unavailable: \(error, privacy: .private)") }
  }

  private func discard(jobID: UUID, work: Work) throws {
    try withWork(work) {
      guard let job = try store.load(id: jobID), !hasOwnershipProvider || job.owner == work.owner else { return }
      try store.remove(id: jobID)
      discarded.insert(jobID)
    }
    notify()
  }

  func discard(jobID: UUID, admission: SharedSessionAdmission) async {
    do {
      guard try await claim(expected: admission) else { return }
      try discard(jobID: jobID, work: makeWork())
    } catch { logger.notice("Capture discard admission unavailable: \(error, privacy: .private)") }
  }

  /// Session end: every job, staged file and note belongs to the account that queued it, so none may be
  /// sent or listed under the next one.
  public func discardAll() {
    discarded.formUnion(((try? store.loadAll()) ?? []).map(\.id))
    discarded.formUnion(inFlight)
    claimedOwner = nil
    claimedAdmission = nil
    ownershipGeneration += 1
    do {
      try store.removeAll()
    } catch {
      logger.error("Clearing capture jobs failed: \(error, privacy: .public)")
    }
    notify()
  }

  /// Session end that keeps the jobs: none is sent or listed again until the next `claim`.
  public func releaseOwner() {
    claimedOwner = nil
    claimedAdmission = nil
    ownershipGeneration += 1
    notify()
  }

  public func releaseOwner(expectedIdentity: SharedSessionIdentity) {
    guard claimedAdmission?.identity == expectedIdentity else { return }
    releaseOwner()
  }

  /// Makes the signed-in account this engine's owner and discards every job it did not queue, unowned ones
  /// included. `false` when no account is signed in, in which case nothing may be sent or listed.
  private func claim(expected: SharedSessionAdmission? = nil) async throws -> Bool {
    let generation = ownershipGeneration
    if let currentAdmission {
      guard makeAdmittedAPI != nil else { throw SharedSessionError.unavailable }
      let admission: SharedSessionAdmission
      if let expected { admission = expected } else { admission = try await currentAdmission() }
      guard generation == ownershipGeneration else { return false }
      do {
        try admission.withCurrent {
          let owner = CaptureOwner(userID: admission.identity.userID, baseURL: admission.identity.baseURL)
          for job in try store.loadAll() where job.owner != owner {
            try store.remove(id: job.id)
            discarded.insert(job.id)
          }
          if claimedAdmission?.identity != admission.identity { ownershipGeneration += 1 }
          claimedAdmission = admission
          claimedOwner = owner
        }
      } catch {
        logger.notice("Capture admission unavailable: \(error, privacy: .public)")
        throw error
      }
      notify()
      return true
    }
    guard let owner = await currentOwner?() else { return false }
    guard generation == ownershipGeneration else { return false }
    if claimedOwner != owner { ownershipGeneration += 1 }
    claimedOwner = owner
    for job in (try? store.loadAll()) ?? [] where job.owner != owner {
      discarded.insert(job.id)
      do {
        try store.remove(id: job.id)
      } catch {
        logger.error("Discarding another account's capture failed: \(error, privacy: .public)")
      }
    }
    notify()
    return true
  }

  // MARK: - Job creation

  private func makeJob(for item: ShareItem, destination: CaptureDestination, note: String?, owner: CaptureOwner?) throws -> UploadJob {
    let id = UUID()
    do {
      let payload: UploadPayload
      switch (item, destination) {
      case (.url(let url), .session):
        payload = .message(url.absoluteString)
      case (.text(let text), .session):
        payload = .message(text)
      case (.url(let url), .lake):
        let name = "Link - \(url.host() ?? "page").txt"
        payload = try stageText("\(url.absoluteString)\n", name: name, jobID: id)
      case (.text(let text), .lake):
        payload = try stageText(text, name: "Note \(Self.stamp(now())).txt", jobID: id)
      case (.image(let file), _), (.pdf(let file), _), (.file(let file), _):
        _ = try store.stagePayload(copying: file.fileURL, jobID: id, fileName: file.fileName)
        payload = .file(name: file.fileName, mimeType: file.mimeType, byteCount: file.byteCount)
      }
      let job = UploadJob(id: id, destination: destination, payload: payload, note: note, now: now(), owner: owner)
      return job
    } catch {
      store.discardPayload(jobID: id)
      throw error
    }
  }

  private func stageText(_ text: String, name: String, jobID: UUID) throws -> UploadPayload {
    let data = Data(text.utf8)
    _ = try store.writePayload(data, jobID: jobID, fileName: name)
    return .file(name: name, mimeType: "text/plain", byteCount: data.count)
  }

  private static func stamp(_ date: Date) -> String {
    date.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false).timeSeparator(.omitted))
  }

  // MARK: - Advancing

  /// Moves one job as far as it can go without waiting on the network's other side: `queued` runs to
  /// `uploading`, `registering` runs to `done`. A job makes at most a couple of transitions per pass; the
  /// step cap only matters if the store stops recording them (a full disk), which must not spin.
  private func advance(_ id: UUID, work: Work) async {
    guard inFlight.insert(id).inserted else { return }
    defer { inFlight.remove(id) }
    for _ in 0..<4 {
      guard let job = try? withWork(work, { try store.load(id: id) }),
        (try? withWork(work, job: job, { true })) == true else { return }
      switch job.stage {
      case .queued:
        guard await startUpload(job, work: work) else { return }
      case .registering:
        await register(job, work: work)
        return
      case .uploading, .done, .failed:
        return
      }
    }
  }

  /// Returns whether the job changed stage in a way the caller should keep advancing.
  private func startUpload(_ job: UploadJob, work: Work) async -> Bool {
    var job = job
    guard case .file(let name, let mimeType, let byteCount) = job.payload else {
      do {
        _ = try changeJob(job, work: work) { $0.stage = .registering }
        return true
      } catch {
        fail(&job, error, work: work)
        return false
      }
    }
    let file = store.payloadURL(jobID: job.id, fileName: name)
    guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else {
      fail(&job, CaptureError.payloadMissing, work: work)
      return false
    }
    do {
      try validate(work, job: job)
      let ticket = try await work.api.createUpload(fileName: name, mimeType: mimeType, byteCount: byteCount)
      try validate(work, job: job)
      let uploader = uploader(for: ownIdentifier)
      let taskID = try await uploader.start(jobID: job.id, file: file, to: ticket.uploadURL, contentType: mimeType)
      try validate(work, job: job)
      _ = try changeJob(job, work: work) { next in
        next.ticket = ticket
        next.uploadSession = ownIdentifier
        next.uploadTaskID = taskID
        next.uploadAttempts += 1
        next.lastError = nil
        next.stage = .uploading
      }
    } catch is CancellationError {
    } catch {
      fail(&job, error, work: work)
    }
    return false
  }

  /// Waits for the file to scan clean, then attaches it. Network trouble leaves the job `registering` for the
  /// next pass; only a permanent refusal fails it.
  private func register(_ job: UploadJob, work: Work) async {
    var job = job
    do {
      switch job.payload {
      case .file:
        guard let fileID = job.ticket?.fileID else { throw CaptureError.payloadMissing }
        guard try await waitUntilClean(fileID: fileID, job: job, work: work) else {
          _ = try changeJob(job, work: work) { $0.lastError = "Still being scanned" }
          return
        }
        switch job.destination {
        case .lake(let lakeID, _):
          if let note = job.note {
            try validate(work, job: job)
            try await work.api.setNotes(fileID: fileID, notes: note)
            try validate(work, job: job)
          }
          try validate(work, job: job)
          try await work.api.addFileToLake(lakeID: lakeID, fileID: fileID)
          try validate(work, job: job)
        case .session(let sessionID, _):
          try await sendTurn(&job, sessionID: sessionID, fileIDs: [fileID], work: work)
        }
      case .message:
        guard case .session(let sessionID, _) = job.destination else { throw CaptureError.payloadMissing }
        try await sendTurn(&job, sessionID: sessionID, fileIDs: [], work: work)
      }
      job = try changeJob(job, work: work) { next in
        next.stage = .done
        next.lastError = nil
      }
      try withWork(work, job: job, checkState: true) { store.discardPayload(jobID: job.id) }
    } catch is CancellationError {
    } catch {
      fail(&job, error, work: work)
    }
  }

  /// `POST /api/chat` is not idempotent: a timeout or 5xx after the server accepted the turn would, on a
  /// blind retry, post it twice and charge for it twice. So the attempt is recorded before the request, and
  /// any later pass first looks for the turn on the server.
  private func sendTurn(_ job: inout UploadJob, sessionID: String, fileIDs: [String], work: Work) async throws {
    try validate(work, job: job)
    let message = Self.message(for: job)
    if let attemptedAt = job.sendAttemptedAt {
      let lookup = try await work.api.findSentTurn(
        sessionID: sessionID, message: message, sentAfter: attemptedAt.addingTimeInterval(-configuration.sendClockSkew))
      try validate(work, job: job)
      switch lookup {
      case .found(let questID):
        let jobID = job.id
        logger.notice(
          "Capture job \(jobID, privacy: .public) already reached quest \(questID, privacy: .public); not resending")
        try validate(work, job: job)
        await didSendToSession?(sessionID)
        try validate(work, job: job)
        return
      case .notFound:
        break
      case .inconclusive:
        // Failure records this uncertainty atomically; an explicit retry permits another send.
        throw CaptureError.deliveryUnknown
      }
    }
    job = try changeJob(job, work: work) { next in
      next.sendAttemptedAt = now()
      next.sendAttemptID = UUID()
    }
    try validate(work, job: job)
    try await work.api.sendSessionMessage(sessionID: sessionID, message: message, fileIDs: fileIDs)
    try validate(work, job: job)
    await didSendToSession?(sessionID)
    try validate(work, job: job)
  }

  private func waitUntilClean(fileID: String, job: UploadJob, work: Work) async throws -> Bool {
    for poll in 0..<configuration.maxPollsPerPass {
      try validate(work, job: job)
      let status = try await work.api.fileStatus(fileID: fileID)
      try validate(work, job: job)
      switch status {
      case .clean, .unscanned: return true
      case .blocked: throw CaptureError.blocked
      case .pending, .scanning:
        if poll < configuration.maxPollsPerPass - 1 {
          await sleep(configuration.pollInterval)
          try validate(work, job: job)
        }
      }
    }
    return false
  }

  static func message(for job: UploadJob) -> String {
    switch job.payload {
    case .message(let text): [text, job.note].compactMap { $0 }.joined(separator: "\n\n")
    case .file(let name, _, _): job.note ?? "Attached \(name)"
    }
  }

  // MARK: - Failure

  /// Transient trouble leaves the job where it is with the reason recorded (up to
  /// `maxRegisterFailures` in `registering`); anything else fails it.
  private func fail(_ job: inout UploadJob, _ error: any Error, work: Work) {
    // A rejected capability or newer durable state is a stop, not a failure of the old job.
    if error is SharedSessionError { return }
    let reason = Self.describe(error)
    do {
      job = try changeJob(job, work: work) { next in
        next.lastError = reason
        if Self.isTransient(error) {
          if next.stage == .registering { next.registerFailures += 1 }
          if next.registerFailures >= configuration.maxRegisterFailures {
            let failures = next.registerFailures
            logger.error("Capture job gave up after \(failures) failures: \(reason, privacy: .public)")
            next.stage = .failed
          } else {
            logger.notice("Capture job waiting to retry: \(reason, privacy: .public)")
          }
        } else {
          next.stage = .failed
        }
        if let captureError = error as? CaptureError, case .deliveryUnknown = captureError {
          next.sendAttemptedAt = nil
          next.sendAttemptID = nil
        }
      }
    } catch is SharedSessionError {
      logger.debug("Capture changed before its failure could be recorded")
    } catch {
      logger.error("Recording capture failure failed: \(error, privacy: .public)")
    }
  }

  /// The job store refused a write; nothing may go out that the store cannot record.
  struct StoreUnavailable: Error {}

  static func isTransient(_ error: any Error) -> Bool {
    if error is StoreUnavailable { return true }
    guard let api = error as? APIError else { return false }
    switch api {
    case .offline, .rateLimited, .server, .signedOut: return true
    case .forbidden, .notFound, .malformedResponse, .upgradeRequired: return false
    }
  }

  static func describe(_ error: any Error) -> String {
    switch error {
    case CaptureError.rejected(let message): message
    case CaptureError.turnRefused(let message): message ?? "The conversation could not take this message."
    case CaptureError.blocked: "The file was blocked by the server's scan."
    case CaptureError.payloadMissing: "The file is no longer on this device."
    case CaptureError.deliveryUnknown: "This may already be in the conversation. Retry to send it again."
    case is StoreUnavailable: "This device is out of storage."
    case APIError.signedOut: "Sign in to Bike4Mind to finish this."
    case APIError.offline: "No connection."
    case APIError.forbidden: "You don't have permission to add to this destination."
    case APIError.notFound: "The destination no longer exists."
    case APIError.rateLimited: "Too many requests; will retry."
    case APIError.server: "Bike4Mind had a problem. Try again in a moment."
    case APIError.upgradeRequired: "Update Bike4Mind to keep sending."
    case let error as SharedSessionError: error.localizedDescription
    default: "Something went wrong."
    }
  }

  // MARK: - Events and restore

  private func uploader(for identifier: String) -> any BackgroundUploading {
    if let existing = uploaders[identifier] { return existing }
    let uploader = makeUploader(identifier)
    uploaders[identifier] = uploader
    let events = uploader.events()
    eventTasks[identifier] = Task { [weak self] in
      for await event in events {
        await self?.handle(event, from: identifier)
      }
    }
    return uploader
  }

  /// A PUT finished. Stale events (the job moved on, or was retried under another task) are ignored.
  func handle(_ event: UploadEvent, from identifier: String) async {
    do {
      if hasOwnershipProvider { guard try await claim() else { return } }
      let work = try makeWork()
      let changed = try updateJob(event.jobID, work: work) { job in
        guard job.stage == .uploading, job.uploadTaskID == event.taskID, job.uploadSession == identifier else { return false }
        switch event.outcome {
        case .succeeded:
          job.stage = .registering
          job.lastError = nil
        case .failed(let status):
          job.ticket = nil
          job.uploadSession = nil
          job.uploadTaskID = nil
          job.lastError = status.map { "Upload failed (HTTP \($0))." } ?? "Upload interrupted."
          job.stage = job.uploadAttempts < configuration.maxUploadAttempts ? .queued : .failed
        }
        return true
      }
      if changed { await advance(event.jobID, work: work) }
    } catch { logger.notice("Capture event unavailable: \(error, privacy: .private)") }
  }

  func reconcile() async {
    do { try await reconcile(work: makeWork()) }
    catch { logger.notice("Capture reconciliation unavailable: \(error, privacy: .private)") }
  }

  private func reconcile(work: Work) async throws {
    let uploading = try jobs(work: work).filter { $0.stage == .uploading }
    guard !uploading.isEmpty else { return }
    let own = uploader(for: ownIdentifier)
    if uploading.contains(where: { $0.uploadSession == ownIdentifier }) {
      await sleep(configuration.reconcileGrace)
      try validate(work)
    }
    let live = await own.liveJobIDs()
    try validate(work)
    for candidate in uploading {
      try updateJob(candidate.id, work: work) { job in
        guard job == candidate,
          UploadReconciler.shouldRequeue(job, liveJobIDs: live, ownIdentifier: ownIdentifier,
            now: now(), foreignStaleAfter: configuration.foreignUploadStaleAfter) else { return false }
        job.ticket = nil
        job.uploadSession = nil
        job.uploadTaskID = nil
        job.lastError = "Upload was interrupted."
        job.stage = job.uploadAttempts < configuration.maxUploadAttempts ? .queued : .failed
        return true
      }
    }
  }

  private func prune(work: Work) throws {
    try withWork(work) {
      let cutoff = now().addingTimeInterval(-configuration.doneRetention)
      for job in try store.loadAll() where job.stage == .done && job.updatedAt < cutoff {
        guard !hasOwnershipProvider || job.owner == work.owner else { continue }
        do {
          try store.remove(id: job.id)
          discarded.insert(job.id)
        } catch { logger.error("Pruning capture failed: \(error, privacy: .private)") }
      }
    }
  }

  /// Compare and save under one admission lock, then return the store's canonical date representation.
  private func changeJob(
    _ expected: UploadJob, work: Work, _ change: (inout UploadJob) -> Void
  ) throws -> UploadJob {
    defer { notify() }
    return try withWork(work, job: expected, checkState: true) {
      var next = expected
      change(&next)
      next.updatedAt = now()
      try store.save(next)
      guard let saved = try store.load(id: next.id), saved.id == next.id, saved.owner == next.owner,
        saved.stage == next.stage, saved.sendAttemptID == next.sendAttemptID,
        (saved.sendAttemptedAt == nil) == (next.sendAttemptedAt == nil)
      else { throw StoreUnavailable() }
      return saved
    }
  }

}

public enum CaptureOwnershipError: Error, Equatable {
  /// No account is signed in to own the capture.
  case noSignedInAccount
}

extension String {
  fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
