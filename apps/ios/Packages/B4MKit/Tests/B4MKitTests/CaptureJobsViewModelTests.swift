import XCTest

@testable import B4MKit

private actor StubTracker: CaptureJobTracking {
  private var current: [UploadJob]
  private var continuation: AsyncStream<[UploadJob]>.Continuation?
  private(set) var retried: [UUID] = []

  init(_ jobs: [UploadJob] = []) { current = jobs }

  func jobs() -> [UploadJob] { current }

  func updates() -> AsyncStream<[UploadJob]> {
    let (stream, continuation) = AsyncStream<[UploadJob]>.makeStream()
    self.continuation = continuation
    continuation.yield(current)
    return stream
  }

  func retry(jobID: UUID) async { retried.append(jobID) }

  func publish(_ jobs: [UploadJob]) {
    current = jobs
    continuation?.yield(jobs)
  }
}

private func job(_ name: String, stage: UploadStage, error: String? = nil) -> UploadJob {
  var job = UploadJob(
    destination: .lake(id: "l1", name: "Research"), payload: .file(name: name, mimeType: "text/plain", byteCount: 1),
    note: nil, now: Date(timeIntervalSince1970: 0))
  job.stage = stage
  job.lastError = error
  return job
}

@MainActor
final class CaptureJobsViewModelTests: XCTestCase {
  func testNothingShowsUntilThereAreJobs() {
    let model = CaptureJobsViewModel(tracker: StubTracker())
    XCTAssertFalse(model.isVisible)
    XCTAssertEqual(model.chipTitle, "")
  }

  func testFinishedJobsAreHidden() {
    let model = CaptureJobsViewModel(tracker: StubTracker())
    model.apply([job("a.txt", stage: .done)])
    XCTAssertFalse(model.isVisible)
    model.apply([job("a.txt", stage: .done), job("b.txt", stage: .uploading)])
    XCTAssertEqual(model.rows.map(\.name), ["b.txt"])
  }

  func testChipTitleCountsActiveAndFailedJobs() {
    let model = CaptureJobsViewModel(tracker: StubTracker())
    model.apply([job("a", stage: .queued)])
    XCTAssertEqual(model.chipTitle, "Uploading")
    XCTAssertFalse(model.needsAttention)
    model.apply([job("a", stage: .queued), job("b", stage: .registering), job("c", stage: .uploading)])
    XCTAssertEqual(model.chipTitle, "Uploading 3")
    model.apply([job("a", stage: .failed)])
    XCTAssertEqual(model.chipTitle, "Upload failed")
    XCTAssertTrue(model.needsAttention)
    model.apply([job("a", stage: .failed), job("b", stage: .failed)])
    XCTAssertEqual(model.chipTitle, "2 failed")
    model.apply([job("a", stage: .failed), job("b", stage: .uploading)])
    XCTAssertEqual(model.chipTitle, "1 uploading, 1 failed")
  }

  func testRowsCarryStageLabelErrorAndRetryability() {
    let model = CaptureJobsViewModel(tracker: StubTracker())
    model.apply([
      job("waiting.txt", stage: .queued, error: "No connection."), job("broken.txt", stage: .failed, error: "Blocked."),
    ])
    XCTAssertEqual(model.rows[0].stageLabel, "Waiting")
    XCTAssertEqual(model.rows[0].detail, "No connection.")
    XCTAssertFalse(model.rows[0].canRetry)
    XCTAssertEqual(model.rows[1].stageLabel, "Failed")
    XCTAssertEqual(model.rows[1].destinationName, "Research")
    XCTAssertTrue(model.rows[1].canRetry)
  }

  func testObserveFollowsTheStreamAndReloadReadsASnapshot() async {
    let tracker = StubTracker([job("a", stage: .uploading)])
    let model = CaptureJobsViewModel(tracker: tracker)
    let observing = Task { await model.observe() }
    await settle { model.rows.count == 1 }
    await tracker.publish([])
    await settle { !model.isVisible }
    observing.cancel()

    await tracker.publish([job("late", stage: .queued)])
    await model.reload()
    XCTAssertEqual(model.rows.map(\.name), ["late"])
  }

  func testRetryIsForwardedToTheTracker() async {
    let tracker = StubTracker()
    let failed = job("a", stage: .failed)
    await CaptureJobsViewModel(tracker: tracker).retry(failed.id)
    let retried = await tracker.retried
    XCTAssertEqual(retried, [failed.id])
  }

  private func settle(_ condition: @MainActor () -> Bool) async {
    for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertTrue(condition())
  }
}

final class FixtureCaptureJobsTests: XCTestCase {
  private func fixture() -> FixtureCaptureJobs {
    FixtureCaptureJobs(submitDelay: .zero, stepDelay: .milliseconds(30))
  }

  private func waitFor(_ stage: UploadStage, in jobs: FixtureCaptureJobs) async -> UploadJob? {
    for _ in 0..<400 {
      if let match = await jobs.jobs().first(where: { $0.stage == stage }) { return match }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return nil
  }

  func testASubmittedItemWalksEveryStageToDone() async throws {
    let jobs = fixture()
    var seen: [UploadStage] = []
    let stream = await jobs.updates()
    let sent = try await jobs.submit([.text("hello")], to: .session(id: "s", name: "Trip"), note: nil)
    XCTAssertEqual(sent.first?.stage, .queued)
    for await snapshot in stream {
      guard let stage = snapshot.first?.stage, seen.last != stage else { continue }
      seen.append(stage)
      if stage == .done { break }
    }
    XCTAssertEqual(seen, [.queued, .uploading, .registering, .done])
  }

  func testTheFirstSendToTheReceiptsLakeFailsAndRetrySucceeds() async throws {
    let jobs = fixture()
    try await jobs.submit([.text("receipt")], to: .lake(id: "fixture-lake-receipts", name: "Receipts"), note: nil)
    let failed = await waitFor(.failed, in: jobs)
    XCTAssertEqual(failed?.lastError, "No connection.")
    await jobs.retry(jobID: try XCTUnwrap(failed).id)
    let done = await waitFor(.done, in: jobs)
    XCTAssertNil(done?.lastError)
  }
}
