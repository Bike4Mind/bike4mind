import XCTest

@testable import B4MKit

final class CaptureEngineTests: XCTestCase {
  private let temp = TempDirectory()
  private let lake = CaptureDestination.lake(id: "lake-1", name: "Research")
  private let session = CaptureDestination.session(id: "sess-1", name: "Trip")
  private let clock = TestClock()

  private struct Rig {
    let engine: CaptureEngine
    let api: FakeCaptureAPI
    let uploader: FakeUploader
    let store: FileUploadJobStore
  }

  private func rig(
    api: FakeCaptureAPI = FakeCaptureAPI(), store: FileUploadJobStore? = nil,
    identifier: String = BackgroundSessionIdentifier.app, uploader: FakeUploader? = nil
  ) -> Rig {
    let store = store ?? FileUploadJobStore(directory: temp.url)
    let uploader = uploader ?? FakeUploader(identifier: identifier)
    let clock = clock
    let engine = CaptureEngine(
      store: store, api: api, ownIdentifier: identifier, makeUploader: { _ in uploader }, now: { clock.now },
      sleep: { _ in }, configuration: Self.fastConfiguration)
    return Rig(engine: engine, api: api, uploader: uploader, store: store)
  }

  private static var fastConfiguration: CaptureEngine.Configuration {
    var configuration = CaptureEngine.Configuration()
    configuration.maxPollsPerPass = 3
    return configuration
  }

  /// Waits (briefly) for an async condition, since uploader events are consumed on another task.
  private func eventually(_ message: String = "condition", _ condition: () async -> Bool) async throws {
    for _ in 0..<200 {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("timed out waiting for \(message)")
  }

  private func stage(_ rig: Rig, _ id: UUID) -> UploadStage? {
    try? rig.store.load(id: id)?.stage
  }

  private func only(_ jobs: [UploadJob]) throws -> UploadJob {
    try XCTUnwrap(jobs.first)
  }

  private func photo(_ name: String = "photo.jpg") -> ShareItem { .image(sharedFile(temp, name: name)) }

  // MARK: - Happy paths

  func testALakeCaptureRunsQueuedUploadingRegisteringDone() async throws {
    let rig = rig()
    let jobs = try await rig.engine.submit([photo()], to: lake, note: "from the trail")
    let job = try XCTUnwrap(jobs.first)

    XCTAssertEqual(job.stage, .uploading)
    XCTAssertEqual(job.uploadSession, BackgroundSessionIdentifier.app)
    XCTAssertEqual(job.uploadAttempts, 1)
    let started = try XCTUnwrap(rig.uploader.started.first)
    XCTAssertEqual(started.contentType, "image/jpeg")
    XCTAssertEqual(started.url.path(), "/put/1")
    XCTAssertTrue(FileManager.default.fileExists(atPath: started.file.path(percentEncoded: false)))

    rig.uploader.finish(job.id)
    try await eventually("done") { stage(rig, job.id) == .done }

    let calls = await rig.api.calls
    XCTAssertEqual(
      calls,
      [
        .createUpload(name: "photo.jpg", mime: "image/jpeg", size: 5),
        .fileStatus("file-1"),
        .setNotes(file: "file-1", notes: "from the trail"),
        .addToLake(lake: "lake-1", file: "file-1"),
      ])
    try await eventually("payload deleted once the file is attached") {
      !FileManager.default.fileExists(atPath: started.file.path(percentEncoded: false))
    }
  }

  func testNoNoteMeansNoNotesCall() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo()], to: lake, note: "  "))
    rig.uploader.finish(job.id)
    try await eventually { stage(rig, job.id) == .done }
    let calls = await rig.api.calls
    XCTAssertFalse(calls.contains { if case .setNotes = $0 { true } else { false } })
  }

  func testASessionCaptureSendsAMessageCarryingTheFile() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo("menu.jpg")], to: session, note: "what is good here?"))
    rig.uploader.finish(job.id)
    try await eventually { stage(rig, job.id) == .done }
    let calls = await rig.api.calls
    XCTAssertEqual(calls.last, .sendMessage(session: "sess-1", message: "what is good here?", files: ["file-1"]))
  }

  func testASessionCaptureWithoutANoteNamesTheFile() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo("menu.jpg")], to: session, note: nil))
    rig.uploader.finish(job.id)
    try await eventually { stage(rig, job.id) == .done }
    let calls = await rig.api.calls
    XCTAssertEqual(calls.last, .sendMessage(session: "sess-1", message: "Attached menu.jpg", files: ["file-1"]))
  }

  func testSharedTextToASessionIsAMessageWithNoUpload() async throws {
    let rig = rig()
    let link = URL(string: "https://example.com/a")!
    let jobs = try await rig.engine.submit([.url(link), .text("remember this")], to: session, note: "fyi")
    XCTAssertEqual(jobs.map(\.stage), [.done, .done])
    let calls = await rig.api.calls
    XCTAssertEqual(
      calls,
      [
        .sendMessage(session: "sess-1", message: "https://example.com/a\n\nfyi", files: []),
        .sendMessage(session: "sess-1", message: "remember this\n\nfyi", files: []),
      ])
    XCTAssertTrue(rig.uploader.started.isEmpty)
  }

  func testSharedTextAndLinksToALakeBecomeTextFiles() async throws {
    let rig = rig()
    let jobs = try await rig.engine.submit(
      [.url(URL(string: "https://example.com/a")!), .text("a thought")], to: lake, note: nil)
    XCTAssertEqual(jobs.count, 2)
    let calls = await rig.api.calls
    XCTAssertEqual(calls.first, .createUpload(name: "Link - example.com.txt", mime: "text/plain", size: 22))
    XCTAssertTrue(
      calls.contains {
        if case .createUpload(let name, "text/plain", 9) = $0 { name.hasPrefix("Note ") } else { false }
      })
    let linkPayload = try XCTUnwrap(rig.uploader.started.first)
    XCTAssertEqual(try String(contentsOf: linkPayload.file, encoding: .utf8), "https://example.com/a\n")
  }

  func testEachSharedItemIsItsOwnJob() async throws {
    let rig = rig()
    let jobs = try await rig.engine.submit([photo("a.jpg"), photo("b.jpg")], to: lake, note: nil)
    XCTAssertEqual(jobs.count, 2)
    XCTAssertEqual(Set(rig.uploader.started.map(\.jobID)).count, 2)
    XCTAssertEqual(try rig.store.loadAll().count, 2)
  }

  // MARK: - Registration

  func testAFileStillScanningStaysRegisteringThenCompletesOnTheNextPass() async throws {
    let api = FakeCaptureAPI()
    await api.setStatuses([.pending, .scanning, .scanning])
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id)
    try await eventually("registering with a scan note") {
      (try? rig.store.load(id: job.id))?.lastError == "Still being scanned"
    }
    XCTAssertEqual(stage(rig, job.id), .registering)

    await api.setStatuses([.clean])
    await rig.engine.resume()
    XCTAssertEqual(stage(rig, job.id), .done)
    let calls = await rig.api.calls
    XCTAssertEqual(calls.last, .addToLake(lake: "lake-1", file: "file-1"))
  }

  func testABlockedFileFailsTheJob() async throws {
    let api = FakeCaptureAPI()
    await api.setStatuses([.blocked])
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id)
    try await eventually { stage(rig, job.id) == .failed }
    XCTAssertEqual(try rig.store.load(id: job.id)?.lastError, "The file was blocked by the server's scan.")
  }

  func testAnUnscannedLegacyRecordIsTreatedAsClean() async throws {
    let api = FakeCaptureAPI()
    await api.setStatuses([.unscanned])
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id)
    try await eventually { stage(rig, job.id) == .done }
  }

  func testATransientAttachFailureKeepsTheJobRegisteringForTheNextPass() async throws {
    let api = FakeCaptureAPI()
    await api.setAttachError(APIError.offline)
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id)
    try await eventually { (try? rig.store.load(id: job.id))?.lastError == "No connection." }
    XCTAssertEqual(stage(rig, job.id), .registering)

    await api.setAttachError(nil)
    await rig.engine.resume()
    XCTAssertEqual(stage(rig, job.id), .done)
  }

  func testAPermanentAttachRefusalFailsTheJob() async throws {
    let api = FakeCaptureAPI()
    await api.setAttachError(APIError.forbidden)
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id)
    try await eventually { stage(rig, job.id) == .failed }
  }

  func testARefusedChatTurnFailsASessionCapture() async throws {
    let api = FakeCaptureAPI()
    await api.setAttachError(CaptureError.turnRefused(message: "Not enough credits"))
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([.text("hi")], to: session, note: nil))
    XCTAssertEqual(job.stage, .failed)
    XCTAssertEqual(job.lastError, "Not enough credits")
  }

  // MARK: - Starting an upload

  func testATransientCreateUploadFailureLeavesTheJobQueuedForRetry() async throws {
    let api = FakeCaptureAPI()
    await api.setCreateUploadError(APIError.offline)
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    XCTAssertEqual(job.stage, .queued)
    XCTAssertEqual(job.lastError, "No connection.")
    XCTAssertTrue(rig.uploader.started.isEmpty)

    await api.setCreateUploadError(nil)
    await rig.engine.resume()
    XCTAssertEqual(stage(rig, job.id), .uploading)
  }

  func testAServerRejectionFailsTheJobWithItsMessage() async throws {
    let api = FakeCaptureAPI()
    await api.setCreateUploadError(CaptureError.rejected(message: "File type not supported"))
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    XCTAssertEqual(job.stage, .failed)
    XCTAssertEqual(job.lastError, "File type not supported")
  }

  func testAMissingPayloadFailsTheJob() async throws {
    let rig = rig()
    let job = try only(await rig.engine.enqueue([photo()], to: lake, note: nil))
    rig.store.discardPayload(jobID: job.id)
    await rig.engine.resume()
    XCTAssertEqual(stage(rig, job.id), .failed)
  }

  func testEnqueueRollsBackEarlierJobsWhenALaterItemCannotBeStaged() async throws {
    let rig = rig()
    let missing = ShareItem.file(
      SharedFile(fileURL: temp.url.appending(path: "gone.bin"), fileName: "gone.bin", mimeType: "x/y", byteCount: 1))
    do {
      _ = try await rig.engine.enqueue([photo(), missing], to: lake, note: nil)
      XCTFail("expected failure")
    } catch {}
    XCTAssertEqual(try rig.store.loadAll(), [])
  }

  // MARK: - Failed uploads

  func testAFailedPUTIsRequeuedWithAFreshTicket() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id, outcome: .failed(status: 403))
    try await eventually("second PUT") { (try? rig.store.load(id: job.id))?.uploadAttempts == 2 }
    let reloaded = try XCTUnwrap(try rig.store.load(id: job.id))
    XCTAssertEqual(reloaded.stage, .uploading)
    XCTAssertEqual(reloaded.uploadAttempts, 2)
    XCTAssertEqual(rig.uploader.started.last?.url.path(), "/put/2")
  }

  func testPUTAttemptsAreBounded() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    for attempt in 1...3 {
      try await eventually("PUT \(attempt)") { rig.uploader.started.count == attempt }
      rig.uploader.finish(job.id, outcome: .failed(status: nil))
    }
    try await eventually("failure") { stage(rig, job.id) == .failed }
    XCTAssertEqual(try rig.store.load(id: job.id)?.lastError, "Upload interrupted.")
    XCTAssertEqual(rig.uploader.started.count, 3)
  }

  func testAFailedJobCanBeRetried() async throws {
    let api = FakeCaptureAPI()
    await api.setCreateUploadError(CaptureError.rejected(message: "nope"))
    let rig = rig(api: api)
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    XCTAssertEqual(job.stage, .failed)

    await api.setCreateUploadError(nil)
    await rig.engine.retry(jobID: job.id)
    XCTAssertEqual(stage(rig, job.id), .uploading)
    XCTAssertNil(try rig.store.load(id: job.id)?.lastError)
  }

  func testRetryIgnoresJobsThatAreNotFailed() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    await rig.engine.retry(jobID: job.id)
    XCTAssertEqual(rig.uploader.started.count, 1)
  }

  func testDiscardRemovesTheJobAndItsPayload() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    let file = try XCTUnwrap(rig.uploader.started.first?.file)
    await rig.engine.discard(jobID: job.id)
    XCTAssertNil(try rig.store.load(id: job.id))
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
  }

  func testAStaleCompletionEventIsIgnored() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    await rig.engine.handle(
      UploadEvent(jobID: job.id, taskID: 9_999, outcome: .succeeded), from: BackgroundSessionIdentifier.app)
    XCTAssertEqual(stage(rig, job.id), .uploading, "an event for a task the job no longer owns changes nothing")
    await rig.engine.handle(
      UploadEvent(jobID: job.id, taskID: try XCTUnwrap(job.uploadTaskID), outcome: .succeeded),
      from: BackgroundSessionIdentifier.shareExtension)
    XCTAssertEqual(stage(rig, job.id), .uploading, "nor does one from a session that does not own it")
  }

  // MARK: - App killed mid-upload

  func testAFreshEngineInARelaunchedProcessFinishesAnUploadStartedByTheOldOne() async throws {
    // Process 1 (the share extension) starts the upload and is reaped.
    let extensionRig = rig(identifier: BackgroundSessionIdentifier.shareExtension)
    let job = try only(await extensionRig.engine.submit([photo()], to: lake, note: "n"))
    XCTAssertEqual(job.uploadSession, BackgroundSessionIdentifier.shareExtension)

    // The system finishes the PUT and relaunches the app with the extension's session identifier.
    let reattached = FakeUploader(identifier: BackgroundSessionIdentifier.shareExtension)
    let appEngine = CaptureEngine(
      store: extensionRig.store, api: extensionRig.api, ownIdentifier: BackgroundSessionIdentifier.app,
      makeUploader: { $0 == BackgroundSessionIdentifier.shareExtension ? reattached : FakeUploader(identifier: $0) },
      now: { [clock] in clock.now }, sleep: { _ in }, configuration: Self.fastConfiguration)
    await appEngine.reattach(identifier: BackgroundSessionIdentifier.shareExtension)
    reattached.adopt(job)  // the relaunched session knows the task it ran
    reattached.finish(job.id)

    try await eventually("done in the app") { stage(extensionRig, job.id) == .done }
    let calls = await extensionRig.api.calls
    XCTAssertEqual(calls.last, .addToLake(lake: "lake-1", file: "file-1"))
  }

  func testAnUploadThatDiedWithItsProcessIsRequeuedOnRelaunch() async throws {
    let first = rig()
    let job = try only(await first.engine.submit([photo()], to: lake, note: nil))
    XCTAssertEqual(first.uploader.started.count, 1)

    // New process: same store, a session that no longer lists the task, and no completion event.
    let second = rig(api: first.api, store: first.store, uploader: FakeUploader())
    await second.engine.resume()

    XCTAssertEqual(second.uploader.started.count, 1, "re-queued and started again under a fresh ticket")
    let reloaded = try XCTUnwrap(try second.store.load(id: job.id))
    XCTAssertEqual(reloaded.stage, .uploading)
    XCTAssertEqual(reloaded.uploadAttempts, 2)
  }

  func testAnUploadStillRunningInTheSessionSurvivesRelaunchUntouched() async throws {
    let first = rig()
    let job = try only(await first.engine.submit([photo()], to: lake, note: nil))
    // The same session object (the system kept the task) is reattached by the new engine.
    let second = rig(api: first.api, store: first.store, uploader: first.uploader)
    await second.engine.resume()
    XCTAssertEqual(first.uploader.started.count, 1)
    XCTAssertEqual(try second.store.load(id: job.id)?.uploadAttempts, 1)
  }

  func testAnUploadThatKeepsDyingEventuallyFailsInsteadOfLooping() async throws {
    let first = rig()
    let job = try only(await first.engine.submit([photo()], to: lake, note: nil))
    var current = first
    for _ in 0..<3 {
      current = rig(api: first.api, store: first.store, uploader: FakeUploader())
      await current.engine.resume()
    }
    XCTAssertEqual(stage(current, job.id), .failed)
  }

  func testRegisteringJobsResumeAfterARelaunch() async throws {
    let first = rig()
    let job = try only(await first.engine.submit([photo()], to: lake, note: nil))
    first.uploader.finish(job.id)
    try await eventually { stage(first, job.id) == .done }
    // A second job reaches registering, then the process dies before attaching it.
    var stuck = UploadJob(
      id: UUID(), destination: lake, payload: .file(name: "x.jpg", mimeType: "image/jpeg", byteCount: 5), note: nil,
      now: clock.now)
    stuck.stage = .registering
    stuck.ticket = UploadTicket(
      fileID: "file-77", uploadURL: URL(string: "https://s3.example.test/x")!, expiresAt: .distantFuture)
    try first.store.save(stuck)

    let second = rig(api: first.api, store: first.store, uploader: FakeUploader())
    await second.engine.resume()
    XCTAssertEqual(stage(second, stuck.id), .done)
    let calls = await first.api.calls
    XCTAssertEqual(calls.last, .addToLake(lake: "lake-1", file: "file-77"))
  }

  func testOldFinishedJobsArePrunedOnResume() async throws {
    let rig = rig()
    let job = try only(await rig.engine.submit([.text("x")], to: session, note: nil))
    XCTAssertEqual(job.stage, .done)
    clock.advance(by: 25 * 60 * 60)
    await rig.engine.resume()
    XCTAssertNil(try rig.store.load(id: job.id))
  }

  // MARK: - Reconciler (pure)

  func testReconcilerRules() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func job(session: String?, age: TimeInterval = 0) -> UploadJob {
      var job = UploadJob(destination: lake, payload: .message("x"), note: nil, now: now.addingTimeInterval(-age))
      job.stage = .uploading
      job.uploadSession = session
      return job
    }
    let own = BackgroundSessionIdentifier.app
    let foreign = BackgroundSessionIdentifier.shareExtension
    func requeue(_ job: UploadJob, live: Set<UUID> = []) -> Bool {
      UploadReconciler.shouldRequeue(job, liveJobIDs: live, ownIdentifier: own, now: now, foreignStaleAfter: 1_800)
    }

    let mine = job(session: own)
    XCTAssertTrue(requeue(mine), "own session no longer lists the task")
    XCTAssertFalse(requeue(mine, live: [mine.id]), "own task is still running")
    XCTAssertFalse(requeue(job(session: foreign, age: 60)), "the extension's fresh upload is left to the system")
    XCTAssertTrue(requeue(job(session: foreign, age: 3_600)), "the extension's upload went silent for too long")
    XCTAssertTrue(requeue(job(session: nil)))
    var queued = job(session: own)
    queued.stage = .queued
    XCTAssertFalse(requeue(queued))
  }

  func testObserversSeeEveryTransition() async throws {
    let rig = rig()
    let stream = await rig.engine.updates()
    let collector = Task { () -> [[UploadStage]] in
      var seen: [[UploadStage]] = []
      for await jobs in stream {
        seen.append(jobs.map(\.stage))
        if jobs.first?.stage == .done { break }
      }
      return seen
    }
    let job = try only(await rig.engine.submit([photo()], to: lake, note: nil))
    rig.uploader.finish(job.id)
    let seen = await collector.value
    XCTAssertEqual(seen.first, [])
    XCTAssertTrue(seen.contains([.queued]))
    XCTAssertTrue(seen.contains([.uploading]))
    XCTAssertTrue(seen.contains([.registering]))
    XCTAssertEqual(seen.last, [.done])
  }
}

extension FakeUploader {
  /// Makes a relaunched session aware of a task that was started by another process.
  func adopt(_ job: UploadJob) {
    adopt(jobID: job.id, taskID: job.uploadTaskID ?? -1)
  }
}
