import XCTest

@testable import B4MKit

@MainActor
final class NotificationSettingsTests: XCTestCase {
  func testLocalPrefsDefaultToEnabledAndRoundTrip() async throws {
    let service = LocalNotificationPrefsService(suiteName: "prefs-\(UUID().uuidString)")
    var prefs = await service.load()
    XCTAssertEqual(prefs.count, NotificationCategory.allCases.count)
    XCTAssertTrue(prefs.values.allSatisfy { $0 })

    try await service.setEnabled(false, for: .generationReady)
    prefs = await service.load()
    XCTAssertEqual(prefs[.generationReady], false)
    XCTAssertEqual(prefs[.agentCompleted], true)

    try await service.setEnabled(true, for: .generationReady)
    prefs = await service.load()
    XCTAssertEqual(prefs[.generationReady], true)
  }

  func testCategoryRawValuesMatchTheServerKeys() {
    XCTAssertEqual(
      Set(NotificationCategory.allCases.map(\.rawValue)),
      ["agent_completed", "agent_failed", "approval_needed", "chat_completed", "generation_ready", "agent_message"])
  }

  private func makeModel(
    status: NotificationAuthorization, prefs: any NotificationPrefsService
  )
    -> (NotificationSettingsViewModel, FakeNotificationCenter, FakeRemoteRegistrar)
  {
    let center = FakeNotificationCenter(status: status)
    let remote = FakeRemoteRegistrar()
    let coordinator = PushRegistrationCoordinator(
      center: center, remote: remote, makeAPI: { FakePushTokenAPI() }, environment: .sandbox, appVersion: nil,
      preferences: UserDefaults(suiteName: "settings-\(UUID().uuidString)")!)
    return (NotificationSettingsViewModel(push: coordinator, prefs: prefs, settings: remote), center, remote)
  }

  private func localPrefs() -> LocalNotificationPrefsService {
    LocalNotificationPrefsService(suiteName: "vm-\(UUID().uuidString)")
  }

  func testMasterToggleReflectsSystemAuthorization() async {
    let (authorized, _, _) = makeModel(status: .authorized, prefs: localPrefs())
    await authorized.load()
    XCTAssertTrue(authorized.isMasterEnabled)

    let (denied, _, _) = makeModel(status: .denied, prefs: localPrefs())
    await denied.load()
    XCTAssertFalse(denied.isMasterEnabled)
    XCTAssertTrue(denied.isDenied)

    let (provisional, _, _) = makeModel(status: .provisional, prefs: localPrefs())
    await provisional.load()
    XCTAssertTrue(provisional.isMasterEnabled)
    XCTAssertTrue(provisional.isDeliveringQuietly)
  }

  func testEnablingWhenDeniedSendsTheUserToSystemSettings() async {
    let (model, center, remote) = makeModel(status: .denied, prefs: localPrefs())
    await model.load()
    await model.setMasterEnabled(true)
    XCTAssertEqual(remote.settingsOpened, 1)
    XCTAssertTrue(center.requests.isEmpty)
  }

  func testEnablingWhenUndeterminedShowsThePromptInsteadOfSettings() async {
    let (model, center, remote) = makeModel(status: .notDetermined, prefs: localPrefs())
    await model.load()
    await model.setMasterEnabled(true)
    XCTAssertEqual(center.requests, [.full])
    XCTAssertEqual(remote.settingsOpened, 0)
    XCTAssertTrue(model.isMasterEnabled)
  }

  func testDisablingGoesThroughSystemSettings() async {
    let (model, _, remote) = makeModel(status: .authorized, prefs: localPrefs())
    await model.load()
    await model.setMasterEnabled(false)
    XCTAssertEqual(remote.settingsOpened, 1)
  }

  func testCategoryToggleSavesAndFailureRollsBack() async {
    struct FailingPrefs: NotificationPrefsService {
      func load() async -> [NotificationCategory: Bool] { [:] }
      func setEnabled(_ isEnabled: Bool, for category: NotificationCategory) async throws { throw APIError.offline }
    }
    let local = localPrefs()
    let (model, _, _) = makeModel(status: .authorized, prefs: local)
    await model.load()
    await model.setEnabled(false, for: .agentFailed)
    XCTAssertFalse(model.isEnabled(.agentFailed))
    let stored = await local.load()
    XCTAssertEqual(stored[.agentFailed], false)

    let (failing, _, _) = makeModel(status: .authorized, prefs: FailingPrefs())
    await failing.load()
    await failing.setEnabled(false, for: .agentFailed)
    XCTAssertTrue(failing.isEnabled(.agentFailed))
    XCTAssertNotNil(failing.saveError)
  }
}
