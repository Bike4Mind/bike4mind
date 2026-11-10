import XCTest

@testable import B4MKit

final class DestinationStoreTests: XCTestCase {
  private let lake = CaptureDestination.lake(id: "l1", name: "Research")
  private let session = CaptureDestination.session(id: "s1", name: "Trip")

  private func defaults() -> UserDefaults {
    let name = "b4m.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    addTeardownBlock { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
    return defaults
  }

  func testNothingIsRememberedAtFirst() {
    XCTAssertNil(UserDefaultsDestinationStore(defaults: defaults()).lastDestination())
  }

  func testTheLastDestinationIsRememberedAcrossInstances() {
    let defaults = defaults()
    UserDefaultsDestinationStore(defaults: defaults).remember(lake)
    XCTAssertEqual(UserDefaultsDestinationStore(defaults: defaults).lastDestination(), lake)
    UserDefaultsDestinationStore(defaults: defaults).remember(session)
    XCTAssertEqual(UserDefaultsDestinationStore(defaults: defaults).lastDestination(), session)
  }

  func testForgetClearsIt() {
    let store = UserDefaultsDestinationStore(defaults: defaults())
    store.remember(lake)
    store.forget()
    XCTAssertNil(store.lastDestination())
  }

  func testUnreadableStoredDataIsTreatedAsNothing() {
    let defaults = defaults()
    defaults.set(Data("not json".utf8), forKey: "b4m.capture.lastDestination")
    XCTAssertNil(UserDefaultsDestinationStore(defaults: defaults).lastDestination())
  }

  func testDestinationIdentityKeepsLakesAndSessionsApart() {
    XCTAssertNotEqual(CaptureDestination.lake(id: "x", name: "a").id, CaptureDestination.session(id: "x", name: "a").id)
    XCTAssertTrue(lake.isLake)
    XCTAssertFalse(session.isLake)
    XCTAssertEqual(session.name, "Trip")
  }

  func testInMemoryStoreBehavesTheSame() {
    let store = InMemoryDestinationStore()
    XCTAssertNil(store.lastDestination())
    store.remember(lake)
    XCTAssertEqual(store.lastDestination(), lake)
    store.forget()
    XCTAssertNil(store.lastDestination())
  }
}

private struct StubSource: DestinationSource {
  var lakeResult: Result<[LakeSummary], any Error> = .success([])
  var sessionResult: Result<[SessionSummary], any Error> = .success([])
  func lakes() async throws -> [LakeSummary] { try lakeResult.get() }
  func sessions() async throws -> [SessionSummary] { try sessionResult.get() }
}

private actor RecordingSubmitter: CaptureSubmitting {
  struct Call: Equatable {
    let items: [ShareItem]
    let destination: CaptureDestination
    let note: String?
  }
  private(set) var calls: [Call] = []
  var failure: (any Error)?
  var resultStage = UploadStage.uploading

  /// Items (by display name) whose job fails on submit, whatever `resultStage` says.
  var failingNames: Set<String> = []
  var retryStage = UploadStage.uploading
  private(set) var retried: [UUID] = []
  private(set) var discarded: [UUID] = []
  private var stored: [UploadJob] = []

  func setFailure(_ error: (any Error)?) { failure = error }
  func setResultStage(_ stage: UploadStage) { resultStage = stage }
  func setFailingNames(_ names: Set<String>) { failingNames = names }
  func setRetryStage(_ stage: UploadStage) { retryStage = stage }

  func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?) async throws -> [UploadJob] {
    calls.append(Call(items: items, destination: destination, note: note))
    if let failure { throw failure }
    let created = items.map {
      var job = UploadJob(destination: destination, payload: .message($0.displayName), note: note, now: Date())
      job.stage = failingNames.contains($0.displayName) ? .failed : resultStage
      job.lastError = job.stage == .failed ? "nope" : nil
      return job
    }
    stored += created
    return created
  }

  func retry(jobID: UUID) {
    retried.append(jobID)
    guard let index = stored.firstIndex(where: { $0.id == jobID }) else { return }
    stored[index].stage = retryStage
    stored[index].lastError = retryStage == .failed ? "still nope" : nil
  }

  func discard(jobID: UUID) {
    discarded.append(jobID)
    stored.removeAll { $0.id == jobID }
  }

  func jobs() -> [UploadJob] { stored }

  func failedJobIDs() -> [UUID] { stored.filter { $0.stage == .failed }.map(\.id) }
}

@MainActor
final class ShareComposerModelTests: XCTestCase {
  private let lake = LakeSummary(id: "l1", name: "Research", fileCount: 1, isBuiltIn: false)
  private let session = SessionSummary(
    id: "s1", name: "Trip", lastUsedModel: nil, firstCreated: Date(timeIntervalSince1970: 0),
    lastUpdated: Date(timeIntervalSince1970: 0))
  private let items: [ShareItem] = [.text("hello")]

  private func model(
    source: StubSource? = nil, submitter: RecordingSubmitter = RecordingSubmitter(),
    store: InMemoryDestinationStore = InMemoryDestinationStore()
  ) -> ShareComposerModel {
    let source = source ?? StubSource(lakeResult: .success([lake]), sessionResult: .success([session]))
    return ShareComposerModel(items: items, source: source, submitter: submitter, store: store)
  }

  func testLoadFillsBothListsAndSelectsNothingByDefault() async {
    let model = model()
    XCTAssertEqual(model.phase, .loading)
    await model.load()
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(model.lakes, [lake])
    XCTAssertEqual(model.sessions, [session])
    XCTAssertNil(model.destination)
    XCTAssertNil(model.loadWarning)
    XCTAssertFalse(model.canSubmit)
  }

  func testTheRememberedDestinationIsPreselected() async {
    let store = InMemoryDestinationStore(.lake(id: "l1", name: "Research"))
    let model = model(store: store)
    await model.load()
    XCTAssertEqual(model.destination, .lake(id: "l1", name: "Research"))
    XCTAssertTrue(model.canSubmit)
  }

  func testARememberedDestinationThatNoLongerExistsIsDropped() async {
    let store = InMemoryDestinationStore(.session(id: "deleted", name: "Gone"))
    let model = model(store: store)
    await model.load()
    XCTAssertNil(model.destination)
  }

  func testARememberedDestinationSurvivesWhenItsListCouldNotBeLoaded() async {
    let store = InMemoryDestinationStore(.session(id: "s9", name: "Elsewhere"))
    let source = StubSource(lakeResult: .success([lake]), sessionResult: .failure(APIError.offline))
    let model = model(source: source, store: store)
    await model.load()
    XCTAssertEqual(model.destination, .session(id: "s9", name: "Elsewhere"))
    XCTAssertEqual(model.loadWarning, "Couldn't load your sessions.")
  }

  func testOneFailingListDoesNotHideTheOther() async {
    let source = StubSource(lakeResult: .failure(APIError.forbidden), sessionResult: .success([session]))
    let model = model(source: source)
    await model.load()
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(model.sessions, [session])
    XCTAssertEqual(model.loadWarning, "Couldn't load your lakes.")
  }

  func testSubmitSendsTheItemsAndNoteToTheChosenDestinationAndRemembersIt() async {
    let submitter = RecordingSubmitter()
    let store = InMemoryDestinationStore()
    let model = model(submitter: submitter, store: store)
    await model.load()
    model.choose(.session(id: "s1", name: "Trip"))
    model.note = "context"
    await model.submit()

    XCTAssertEqual(model.phase, .sent)
    let calls = await submitter.calls
    XCTAssertEqual(
      calls, [.init(items: items, destination: .session(id: "s1", name: "Trip"), note: "context")])
    XCTAssertEqual(store.lastDestination(), .session(id: "s1", name: "Trip"))
  }

  func testTheDismissButtonReadsDoneOnceTheSendWentOut() async {
    let model = model()
    await model.load()
    XCTAssertEqual(model.dismissButtonTitle, "Cancel")
    model.choose(.lake(id: "l1", name: "Research"))
    await model.submit()
    XCTAssertEqual(model.phase, .sent)
    XCTAssertEqual(model.dismissButtonTitle, "Done")
  }

  func testTheDismissButtonStaysCancelAfterAFailedSend() async {
    let submitter = RecordingSubmitter()
    await submitter.setResultStage(.failed)
    let model = model(submitter: submitter)
    await model.load()
    model.choose(.lake(id: "l1", name: "Research"))
    await model.submit()
    XCTAssertEqual(model.dismissButtonTitle, "Cancel")
  }

  func testSubmitWithoutADestinationDoesNothing() async {
    let submitter = RecordingSubmitter()
    let model = model(submitter: submitter)
    await model.load()
    await model.submit()
    let calls = await submitter.calls
    XCTAssertTrue(calls.isEmpty)
    XCTAssertEqual(model.phase, .ready)
  }

  func testAFailedSubmitShowsTheReasonAndCanBeRetried() async {
    let submitter = RecordingSubmitter()
    await submitter.setFailure(APIError.offline)
    let store = InMemoryDestinationStore()
    let model = model(submitter: submitter, store: store)
    await model.load()
    model.choose(.lake(id: "l1", name: "Research"))
    await model.submit()
    XCTAssertEqual(model.phase, .failed("No connection."))
    XCTAssertNil(store.lastDestination(), "a destination that was never reached is not remembered")
    XCTAssertTrue(model.canSubmit)

    await submitter.setFailure(nil)
    await model.submit()
    XCTAssertEqual(model.phase, .sent)
  }

  func testAJobThatFailedOutrightIsReportedAsAFailure() async {
    let submitter = RecordingSubmitter()
    await submitter.setResultStage(.failed)
    let model = model(submitter: submitter)
    await model.load()
    model.choose(.lake(id: "l1", name: "Research"))
    await model.submit()
    XCTAssertEqual(model.phase, .failed("nope"))
  }

  func testRetryingAPartlyFailedSendRetriesOnlyTheFailedJob() async {
    let submitter = RecordingSubmitter()
    await submitter.setFailingNames([ShareItem.text("b").displayName])
    let model = ShareComposerModel(
      items: [.text("a"), .text("b")], source: StubSource(), submitter: submitter, store: InMemoryDestinationStore())
    await model.load()
    model.choose(.lake(id: "l", name: "L"))
    await model.submit()
    XCTAssertEqual(model.phase, .failed("nope"))
    XCTAssertEqual(model.items, [.text("b")], "only what did not go through is left to send")
    let failed = await submitter.failedJobIDs()

    await model.submit()
    let calls = await submitter.calls
    let retried = await submitter.retried
    XCTAssertEqual(calls.count, 1, "a second Send must not submit anything new")
    XCTAssertEqual(retried, failed)
    XCTAssertEqual(model.phase, .sent)
  }

  func testAFailedRetryKeepsTheFailedItemForTheNextAttempt() async {
    let submitter = RecordingSubmitter()
    await submitter.setFailingNames([ShareItem.text("b").displayName])
    await submitter.setRetryStage(.failed)
    let model = ShareComposerModel(
      items: [.text("a"), .text("b")], source: StubSource(), submitter: submitter, store: InMemoryDestinationStore())
    await model.load()
    model.choose(.lake(id: "l", name: "L"))
    await model.submit()
    await model.submit()
    XCTAssertEqual(model.phase, .failed("still nope"))
    XCTAssertEqual(model.items, [.text("b")])
    let retried = await submitter.retried
    XCTAssertEqual(retried.count, 1)
  }

  func testChangingTheDestinationAfterAPartialFailureSendsOnlyTheFailedItemsAfresh() async {
    let submitter = RecordingSubmitter()
    await submitter.setFailingNames([ShareItem.text("b").displayName])
    let model = ShareComposerModel(
      items: [.text("a"), .text("b")], source: StubSource(), submitter: submitter, store: InMemoryDestinationStore())
    await model.load()
    model.choose(.lake(id: "l", name: "L"))
    await model.submit()
    let failed = await submitter.failedJobIDs()

    await submitter.setFailingNames([])
    model.choose(.lake(id: "m", name: "M"))
    await model.submit()
    let calls = await submitter.calls
    let discarded = await submitter.discarded
    XCTAssertEqual(
      calls.last, RecordingSubmitter.Call(items: [.text("b")], destination: .lake(id: "m", name: "M"), note: ""))
    XCTAssertEqual(discarded, failed, "the old attempt's failed job does not linger")
    XCTAssertEqual(model.phase, .sent)
  }

  func testRemovingAnItemUpdatesWhatIsSent() async {
    let submitter = RecordingSubmitter()
    let model = ShareComposerModel(
      items: [.text("a"), .text("b")], source: StubSource(), submitter: submitter, store: InMemoryDestinationStore())
    await model.load()
    model.remove(at: 0)
    model.remove(at: 5)
    model.choose(.lake(id: "l", name: "L"))
    await model.submit()
    let calls = await submitter.calls
    XCTAssertEqual(calls.first?.items, [.text("b")])
  }

  func testNothingToSendCannotBeSubmitted() async {
    let model = ShareComposerModel(
      items: [], source: StubSource(), submitter: RecordingSubmitter(), store: InMemoryDestinationStore())
    await model.load()
    model.choose(.lake(id: "l", name: "L"))
    XCTAssertFalse(model.canSubmit)
  }
}

final class RemoteDestinationSourceTests: XCTestCase {
  func testBuiltInLakesAreNotOfferedAndPagesAreFollowed() async throws {
    let api = FakeCaptureAPI()
    await api.setLakePages([
      nil: Page(items: [LakeSummary(id: "a", name: "A", fileCount: 0, isBuiltIn: false)], nextCursor: "n"),
      "n": Page(
        items: [
          LakeSummary(id: "b", name: "B", fileCount: 0, isBuiltIn: true),
          LakeSummary(id: "c", name: "C", fileCount: 0, isBuiltIn: false),
        ], nextCursor: nil),
    ])
    let source = RemoteDestinationSource(capture: api, api: FakeAPI())
    let lakes = try await source.lakes()
    XCTAssertEqual(lakes.map(\.id), ["a", "c"])
  }

  func testPagingIsBounded() async throws {
    let api = FakeCaptureAPI()
    // Every page claims there is more; the source must stop.
    var pages: [String?: Page<LakeSummary>] = [nil: Page(items: [], nextCursor: "n")]
    pages["n"] = Page(items: [LakeSummary(id: "x", name: "X", fileCount: 0, isBuiltIn: false)], nextCursor: "n")
    await api.setLakePages(pages)
    let source = RemoteDestinationSource(capture: api, api: FakeAPI(), maxPages: 3)
    let lakes = try await source.lakes()
    XCTAssertEqual(lakes.count, 2)
  }
}
