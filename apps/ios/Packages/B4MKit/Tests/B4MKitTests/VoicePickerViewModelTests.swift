import XCTest

@testable import B4MKit

/// Each `play` runs until `finish()` or `stop()`; `failNext` makes the next one throw.
actor FakeSamplePlayer: VoiceSamplePlaying {
  private(set) var played: [URL] = []
  private(set) var stopCount = 0
  private var failNext = false
  private var playing: CheckedContinuation<Void, any Error>?

  struct LoadFailed: Error {}

  func setFailNext() { failNext = true }

  func play(_ url: URL) async throws {
    played.append(url)
    if failNext {
      failNext = false
      throw LoadFailed()
    }
    try await withCheckedThrowingContinuation { playing = $0 }
  }

  func stop() {
    stopCount += 1
    finish()
  }

  func finish() {
    playing?.resume()
    playing = nil
  }
}

private let base = URL(string: "https://app.example.test")!
private let alice = VoiceOption(id: "v1", name: "Alice", previewURL: URL(string: "https://cdn.example.test/v1.mp3"))
private let bob = VoiceOption(id: "v2", name: "Bob", previewURL: URL(string: "https://cdn.example.test/v2.mp3"))
private let quiet = VoiceOption(id: "v3", name: "Quiet")

@MainActor
final class VoicePickerViewModelTests: XCTestCase {
  private var store: UserDefaultsVoiceSelectionStore!
  private var api: FakeVoiceAPI!
  private let samples = FakeSamplePlayer()

  override func setUp() async throws {
    let suite = "VoicePickerViewModelTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    store = UserDefaultsVoiceSelectionStore(defaults: defaults)
    api = FakeVoiceAPI()
    api.voices = .success([alice, bob, quiet])
  }

  private func makeModel() async -> (VoicePickerViewModel, VoiceCatalogModel) {
    let catalog = VoiceCatalogModel(wire: api, store: store) { VoiceAccount(userID: "user-1", baseURL: base) }
    let model = VoicePickerViewModel(catalog: catalog, samples: samples)
    await model.load()
    return (model, catalog)
  }

  private func until(_ condition: @MainActor () async -> Bool) async {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Condition not met within 3s")
  }

  func testSelectingAndClearingPersistsAcrossAReinit() async {
    let (model, catalog) = await makeModel()
    await model.select(bob)
    XCTAssertEqual(model.selectedID, "v2")
    let voice = await catalog.premiumVoice()
    XCTAssertEqual(voice, "v2")

    let (relaunched, _) = await makeModel()
    XCTAssertEqual(relaunched.selectedID, "v2", "the pick survives a relaunch")

    await relaunched.select(nil)
    let (again, _) = await makeModel()
    XCTAssertNil(again.selectedID)
  }

  func testOnlyOneSamplePlaysAtATime() async {
    let (model, _) = await makeModel()
    let first = Task { await model.toggleSample(alice) }
    await until { model.playingSampleID == "v1" }
    let second = Task { await model.toggleSample(bob) }
    await until { model.playingSampleID == "v2" }
    await first.value
    XCTAssertEqual(model.playingSampleID, "v2", "the first sample ending does not clear the second")
    let stops = await samples.stopCount
    XCTAssertGreaterThanOrEqual(stops, 1)

    await samples.finish()
    await second.value
    XCTAssertNil(model.playingSampleID)
  }

  func testTappingThePlayingSampleStopsIt() async {
    let (model, _) = await makeModel()
    let playing = Task { await model.toggleSample(alice) }
    await until { model.playingSampleID == "v1" }
    await model.toggleSample(alice)
    await playing.value
    XCTAssertNil(model.playingSampleID)
  }

  func testAVoiceWithoutASampleHasNoPlayButton() async {
    let (model, _) = await makeModel()
    XCTAssertFalse(model.canPlaySample(quiet))
    XCTAssertTrue(model.canPlaySample(alice))
    await model.toggleSample(quiet)
    let played = await samples.played
    XCTAssertEqual(played, [])
  }

  func testLeavingTheScreenStopsTheSample() async {
    let (model, _) = await makeModel()
    let playing = Task { await model.toggleSample(alice) }
    await until { model.playingSampleID == "v1" }
    await model.stopSample()
    await playing.value
    XCTAssertNil(model.playingSampleID)
  }

  func testPickingAVoiceStopsTheSample() async {
    let (model, _) = await makeModel()
    let playing = Task { await model.toggleSample(alice) }
    await until { model.playingSampleID == "v1" }
    await model.select(bob)
    await playing.value
    XCTAssertNil(model.playingSampleID)
  }

  func testASampleThatFailsToLoadResetsQuietly() async {
    let (model, _) = await makeModel()
    await samples.setFailNext()
    await model.toggleSample(alice)
    XCTAssertNil(model.playingSampleID)
  }

  func testAFailedOrEmptyCatalogIsEmptyNotAnError() async {
    api.voices = .failure(.offline)
    let (failed, _) = await makeModel()
    XCTAssertTrue(failed.isEmpty)
    XCTAssertEqual(failed.voices, [])

    api.voices = .success([])
    let (empty, catalog) = await makeModel()
    XCTAssertTrue(empty.isEmpty)
    XCTAssertTrue(catalog.offersVoices, "the row stays so the user can retry")
  }

  func testTheRowIsHiddenWhenVoicesAreOff() async {
    api.flag = .success(false)
    let (_, off) = await makeModel()
    XCTAssertFalse(off.offersVoices)

    api.flag = .success(true)
    api.voices = .failure(.unavailable)
    let (_, refused) = await makeModel()
    XCTAssertFalse(refused.offersVoices)
  }
}
