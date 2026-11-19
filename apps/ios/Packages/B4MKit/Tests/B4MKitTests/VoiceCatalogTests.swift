import XCTest

@testable import B4MKit

/// Scripted voice routes: each call returns the configured result and is counted.
final class FakeVoiceAPI: VoiceAPI, @unchecked Sendable {
  var flag: Result<Bool, VoiceWireError> = .success(true)
  var voices: Result<[VoiceOption], VoiceWireError> = .success([])
  private(set) var voiceListCalls = 0

  func voiceSessionsEnabled() async throws -> Bool { try flag.get() }

  func listVoices() async throws -> [VoiceOption] {
    voiceListCalls += 1
    return try voices.get()
  }

  func synthesizeSpeech(text: String, voiceID: String) async throws -> Data { Data() }
}

private let base = URL(string: "https://app.example.test")!
private let alice = VoiceOption(id: "v1", name: "Alice")
private let bob = VoiceOption(id: "v2", name: "Bob")

@MainActor
final class VoiceCatalogTests: XCTestCase {
  private var defaults: UserDefaults!
  private var store: UserDefaultsVoiceSelectionStore!
  private var api: FakeVoiceAPI!
  private var userID: String? = "user-1"

  override func setUp() async throws {
    let suite = "VoiceCatalogTests.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suite)
    defaults.removePersistentDomain(forName: suite)
    store = UserDefaultsVoiceSelectionStore(defaults: defaults)
    api = FakeVoiceAPI()
  }

  private func makeModel() -> VoiceCatalogModel {
    VoiceCatalogModel(wire: api, store: store) { [unowned self] in
      userID.map { VoiceAccount(userID: $0, baseURL: base) }
    }
  }

  func testFlagOffIsUnavailableAndSkipsTheCatalog() async {
    api.flag = .success(false)
    let model = makeModel()
    await model.load()
    XCTAssertEqual(model.state, .unavailable)
    XCTAssertEqual(api.voiceListCalls, 0)
    let voice = await model.premiumVoice()
    XCTAssertNil(voice)
  }

  /// Flag on but the catalog refused (403 voiceV2Enabled off, 503 provider_not_configured; see VoiceWireTests).
  func testACatalogRefusalIsUnavailableNotAnError() async {
    api.voices = .failure(.unavailable)
    let model = makeModel()
    await model.load()
    XCTAssertEqual(model.state, .unavailable)
    let voice = await model.premiumVoice()
    XCTAssertNil(voice)
  }

  func testOfflineAndServerFailuresAreQuiet() async {
    api.flag = .failure(.offline)
    var model = makeModel()
    await model.load()
    XCTAssertEqual(model.state, .failed(.offline))

    api.flag = .success(true)
    api.voices = .failure(.server(status: 502))
    model = makeModel()
    await model.load()
    XCTAssertEqual(model.state, .failed(.server))
  }

  func testAnEmptyCatalogLoads() async {
    let model = makeModel()
    await model.load()
    XCTAssertEqual(model.state, .loaded([]))
  }

  func testASelectionIsUsedWhileItIsInTheCatalog() async {
    api.voices = .success([alice, bob])
    let model = makeModel()
    await model.load()
    model.select(bob)

    let voice = await model.premiumVoice()
    XCTAssertEqual(voice, "v2")
    XCTAssertEqual(store.selection(for: VoiceAccount(userID: "user-1", baseURL: base)), VoiceSelection(id: "v2", name: "Bob"))
  }

  func testNoSelectionMeansOnDeviceSpeech() async {
    api.voices = .success([alice])
    let voice = await makeModel().premiumVoice()
    XCTAssertNil(voice)
  }

  func testAVoiceRemovedFromTheWorkspaceIsForgotten() async {
    store.setSelection(VoiceSelection(id: "gone", name: "Gone"), for: VoiceAccount(userID: "user-1", baseURL: base))
    api.voices = .success([alice])
    let model = makeModel()

    let voice = await model.premiumVoice()
    XCTAssertNil(voice)
    XCTAssertNil(model.selection)
    XCTAssertNil(store.selection(for: VoiceAccount(userID: "user-1", baseURL: base)))
  }

  func testAFailedRefreshKeepsAKnownSelection() async {
    api.voices = .success([alice])
    let model = makeModel()
    await model.load()
    model.select(alice)

    api.voices = .failure(.offline)
    await model.load()
    XCTAssertEqual(model.state, .failed(.offline))
    let voice = await model.premiumVoice()
    XCTAssertEqual(voice, "v1")
  }

  func testSelectionsAreScopedToAccountAndServer() {
    let first = VoiceAccount(userID: "user-1", baseURL: base)
    let second = VoiceAccount(userID: "user-2", baseURL: base)
    let otherServer = VoiceAccount(userID: "user-1", baseURL: URL(string: "https://staging.example.test")!)
    store.setSelection(VoiceSelection(id: "v1", name: "Alice"), for: first)

    XCTAssertNil(store.selection(for: second))
    XCTAssertNil(store.selection(for: otherServer))
    XCTAssertEqual(store.selection(for: first)?.id, "v1")
  }

  func testASecondAccountDoesNotInheritTheFirstsSelection() async {
    api.voices = .success([alice])
    let model = makeModel()
    await model.load()
    model.select(alice)

    userID = "user-2"
    let other = makeModel()
    let voice = await other.premiumVoice()
    XCTAssertNil(voice)
    XCTAssertNil(other.selection)
  }

  func testResetForgetsEverySelection() async {
    api.voices = .success([alice])
    let model = makeModel()
    await model.load()
    model.select(alice)
    store.setSelection(VoiceSelection(id: "v2", name: "Bob"), for: VoiceAccount(userID: "user-2", baseURL: base))

    model.reset()

    XCTAssertEqual(model.state, .idle)
    XCTAssertNil(model.selection)
    XCTAssertNil(store.selection(for: VoiceAccount(userID: "user-1", baseURL: base)))
    XCTAssertNil(store.selection(for: VoiceAccount(userID: "user-2", baseURL: base)))
  }

  func testSelectionSurvivesANewModel() async {
    api.voices = .success([alice])
    let model = makeModel()
    await model.load()
    model.select(alice)

    let relaunched = makeModel()
    await relaunched.load()
    XCTAssertEqual(relaunched.selection?.id, "v1")
  }
}
