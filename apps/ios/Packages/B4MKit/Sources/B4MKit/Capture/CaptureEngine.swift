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
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "capture")

  private var uploaders: [String: any BackgroundUploading] = [:]
  private var eventTasks: [String: Task<Void, Never>] = [:]
  private var inFlight: Set<UUID> = []
  private var observers: [UUID: AsyncStream<[UploadJob]>.Continuation] = [:]

  /// - Parameters:
  ///   - ownIdentifier: this process's background session (`BackgroundSessionIdentifier.app` or `.shareExtension`).
  ///   - makeUploader: builds the session for an identifier; the app also asks for the extension's.
  public init(
    store: any UploadJobStore,
    api: any CaptureAPI,
    ownIdentifier: String,
    makeUploader: @escaping @Sendable (String) -> any BackgroundUploading,
    now: @escaping @Sendable () -> Date = Date.init,
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    configuration: Configuration = Configuration()
  ) {
    self.store = store
    self.api = api
    self.ownIdentifier = ownIdentifier
    self.makeUploader = makeUploader
    self.now = now
    self.sleep = sleep
    self.configuration = configuration
  }

  // MARK: - Observing

  public func jobs() -> [UploadJob] {
    (try? store.loadAll()) ?? []
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
    let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    var created: [UploadJob] = []
    do {
      for item in items {
        created.append(try makeJob(for: item, destination: destination, note: trimmedNote))
      }
    } catch {
      for job in created { try? store.remove(id: job.id) }
      throw error
    }
    notify()
    return created
  }

  /// Enqueues, then mints tickets and hands every file to the background session. Returns when the bytes are
  /// in the system's hands (or the first problem), which is as long as the share extension needs to stay alive.
  @discardableResult
  public func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?) async throws
    -> [UploadJob]
  {
    let jobs = try enqueue(items, to: destination, note: note)
    for job in jobs { await advance(job.id) }
    return jobs.compactMap { try? store.load(id: $0.id) }
  }

  /// App launch / foreground: retry lost uploads, push every unfinished job forward, prune old results.
  public func resume() async {
    await reconcile()
    prune()
    for job in jobs() where !job.stage.isTerminal { await advance(job.id) }
  }

  /// The system relaunched the app to deliver events of a background session (`identifier`).
  public func reattach(identifier: String) {
    _ = uploader(for: identifier)
  }

  public func retry(jobID: UUID) async {
    guard var job = try? store.load(id: jobID), job.stage == .failed else { return }
    job.stage = .queued
    job.ticket = nil
    job.uploadSession = nil
    job.uploadTaskID = nil
    job.uploadAttempts = 0
    job.lastError = nil
    persist(job)
    await advance(jobID)
  }

  public func discard(jobID: UUID) {
    try? store.remove(id: jobID)
    notify()
  }

  // MARK: - Job creation

  private func makeJob(for item: ShareItem, destination: CaptureDestination, note: String?) throws -> UploadJob {
    let id = UUID()
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
    let job = UploadJob(id: id, destination: destination, payload: payload, note: note, now: now())
    do {
      try store.save(job)
    } catch {
      store.discardPayload(jobID: id)
      throw error
    }
    return job
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
  /// `uploading`, `registering` runs to `done`.
  private func advance(_ id: UUID) async {
    guard inFlight.insert(id).inserted else { return }
    defer { inFlight.remove(id) }
    while let job = try? store.load(id: id) {
      switch job.stage {
      case .queued:
        guard await startUpload(job) else { return }
      case .registering:
        await register(job)
        return
      case .uploading, .done, .failed:
        return
      }
    }
  }

  /// Returns whether the job changed stage in a way the caller should keep advancing.
  private func startUpload(_ job: UploadJob) async -> Bool {
    var job = job
    guard case .file(let name, let mimeType, let byteCount) = job.payload else {
      job.stage = .registering
      persist(job)
      return true
    }
    let file = store.payloadURL(jobID: job.id, fileName: name)
    guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else {
      fail(&job, CaptureError.payloadMissing)
      return false
    }
    do {
      let ticket = try await api.createUpload(fileName: name, mimeType: mimeType, byteCount: byteCount)
      let uploader = uploader(for: ownIdentifier)
      let taskID = try await uploader.start(jobID: job.id, file: file, to: ticket.uploadURL, contentType: mimeType)
      job.ticket = ticket
      job.uploadSession = ownIdentifier
      job.uploadTaskID = taskID
      job.uploadAttempts += 1
      job.lastError = nil
      job.stage = .uploading
      persist(job)
    } catch is CancellationError {
    } catch {
      fail(&job, error)
    }
    return false
  }

  /// Waits for the file to scan clean, then attaches it. Network trouble leaves the job `registering` for the
  /// next pass; only a permanent refusal fails it.
  private func register(_ job: UploadJob) async {
    var job = job
    do {
      switch job.payload {
      case .file:
        guard let fileID = job.ticket?.fileID else { throw CaptureError.payloadMissing }
        guard try await waitUntilClean(fileID: fileID) else {
          job.lastError = "Still being scanned"
          persist(job)
          return
        }
        switch job.destination {
        case .lake(let lakeID, _):
          if let note = job.note { try await api.setNotes(fileID: fileID, notes: note) }
          try await api.addFileToLake(lakeID: lakeID, fileID: fileID)
        case .session(let sessionID, _):
          try await api.sendSessionMessage(
            sessionID: sessionID, message: Self.message(for: job), fileIDs: [fileID])
        }
      case .message:
        guard case .session(let sessionID, _) = job.destination else { throw CaptureError.payloadMissing }
        try await api.sendSessionMessage(sessionID: sessionID, message: Self.message(for: job), fileIDs: [])
      }
      job.stage = .done
      job.lastError = nil
      persist(job)
      store.discardPayload(jobID: job.id)
    } catch is CancellationError {
    } catch {
      fail(&job, error)
    }
  }

  private func waitUntilClean(fileID: String) async throws -> Bool {
    for poll in 0..<configuration.maxPollsPerPass {
      switch try await api.fileStatus(fileID: fileID) {
      case .clean, .unscanned: return true
      case .blocked: throw CaptureError.blocked
      case .pending, .scanning:
        if poll < configuration.maxPollsPerPass - 1 { await sleep(configuration.pollInterval) }
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

  /// Transient trouble leaves the job where it is with the reason recorded; anything else fails it.
  private func fail(_ job: inout UploadJob, _ error: any Error) {
    let reason = Self.describe(error)
    job.lastError = reason
    if Self.isTransient(error) {
      logger.notice("Capture job waiting to retry: \(reason, privacy: .public)")
    } else {
      job.stage = .failed
    }
    persist(job)
  }

  static func isTransient(_ error: any Error) -> Bool {
    guard let api = error as? APIError else { return false }
    switch api {
    case .offline, .rateLimited, .server, .signedOut: return true
    case .forbidden, .notFound, .malformedResponse: return false
    }
  }

  static func describe(_ error: any Error) -> String {
    switch error {
    case CaptureError.rejected(let message): message
    case CaptureError.turnRefused(let message): message ?? "The conversation could not take this message."
    case CaptureError.blocked: "The file was blocked by the server's scan."
    case CaptureError.payloadMissing: "The file is no longer on this device."
    case APIError.signedOut: "Sign in to Bike4Mind to finish this."
    case APIError.offline: "No connection."
    case APIError.forbidden: "You don't have permission to add to this destination."
    case APIError.notFound: "The destination no longer exists."
    case APIError.rateLimited: "Too many requests; will retry."
    case APIError.server: "Bike4Mind had a problem. Try again in a moment."
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
    guard var job = try? store.load(id: event.jobID), job.stage == .uploading,
      job.uploadTaskID == event.taskID, job.uploadSession == identifier
    else { return }
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
    persist(job)
    await advance(job.id)
  }

  /// Puts jobs whose PUT no longer exists back in the queue (or fails them once attempts run out).
  func reconcile() async {
    let uploading = jobs().filter { $0.stage == .uploading }
    guard !uploading.isEmpty else { return }
    let own = uploader(for: ownIdentifier)
    if uploading.contains(where: { $0.uploadSession == ownIdentifier }) { await sleep(configuration.reconcileGrace) }
    let live = await own.liveJobIDs()
    for var job in jobs() where job.stage == .uploading {
      guard
        UploadReconciler.shouldRequeue(
          job, liveJobIDs: live, ownIdentifier: ownIdentifier, now: now(),
          foreignStaleAfter: configuration.foreignUploadStaleAfter)
      else { continue }
      job.ticket = nil
      job.uploadSession = nil
      job.uploadTaskID = nil
      job.lastError = "Upload was interrupted."
      job.stage = job.uploadAttempts < configuration.maxUploadAttempts ? .queued : .failed
      persist(job)
    }
  }

  private func prune() {
    let cutoff = now().addingTimeInterval(-configuration.doneRetention)
    for job in jobs() where job.stage == .done && job.updatedAt < cutoff { try? store.remove(id: job.id) }
  }

  private func persist(_ job: UploadJob) {
    var job = job
    job.updatedAt = now()
    do {
      try store.save(job)
    } catch {
      logger.error("Saving capture job failed: \(error, privacy: .public)")
    }
    notify()
  }
}

extension String {
  fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
