import XCTest

@testable import B4MKit

@MainActor
final class FakeNotificationCenter: NotificationCenterProviding {
  var status: NotificationAuthorization
  /// What the status becomes after a request of each kind.
  var statusAfterProvisional: NotificationAuthorization = .provisional
  var statusAfterFull: NotificationAuthorization = .authorized
  private(set) var requests: [AuthorizationRequestKind] = []
  private(set) var badgeCounts: [Int] = []

  init(status: NotificationAuthorization) { self.status = status }

  func authorizationStatus() async -> NotificationAuthorization { status }

  func requestAuthorization(_ kind: AuthorizationRequestKind) async throws -> Bool {
    requests.append(kind)
    switch kind {
    case .provisional where status == .notDetermined: status = statusAfterProvisional
    case .full where status != .denied: status = statusAfterFull
    default: break
    }
    return status.allowsDelivery
  }

  func setBadgeCount(_ count: Int) async { badgeCounts.append(count) }
}

@MainActor
final class FakeRemoteRegistrar: RemoteNotificationRegistering, SystemSettingsOpening {
  private(set) var registerCalls = 0
  private(set) var settingsOpened = 0
  func registerForRemoteNotifications() { registerCalls += 1 }
  func openAppSettings() { settingsOpened += 1 }
}

actor FakePushTokenAPI: PushTokenAPI {
  struct Registration: Equatable {
    let token: String
    let environment: PushEnvironment
    let appVersion: String?
  }
  private(set) var registrations: [Registration] = []
  private(set) var unregistered: [String] = []
  private var registerError: (any Error)?
  private var unregisterDelay: Duration?

  func failRegistration(with error: (any Error)?) { registerError = error }
  func delayUnregister(by delay: Duration?) { unregisterDelay = delay }

  func registerPushToken(_ token: String, environment: PushEnvironment, appVersion: String?) async throws {
    if let registerError { throw registerError }
    registrations.append(Registration(token: token, environment: environment, appVersion: appVersion))
  }

  struct LiveActivityRegistration: Equatable {
    let token: String
    let activityID: String
    let questID: String
    let environment: PushEnvironment
  }
  private(set) var liveActivityRegistrations: [LiveActivityRegistration] = []
  private(set) var liveActivityAttempts = 0
  private var liveActivityFailures = 0

  /// The next `count` live activity registrations throw `registerError` (or `.offline`), then succeed.
  func failLiveActivityRegistrations(_ count: Int) { liveActivityFailures = count }

  func registerLiveActivityToken(
    _ token: String, activityID: String, questID: String, environment: PushEnvironment, appVersion: String?
  ) async throws {
    liveActivityAttempts += 1
    if liveActivityFailures > 0 {
      liveActivityFailures -= 1
      throw registerError ?? APIError.offline
    }
    liveActivityRegistrations.append(
      LiveActivityRegistration(token: token, activityID: activityID, questID: questID, environment: environment))
  }

  func unregisterPushToken(_ token: String) async throws {
    if let unregisterDelay { try await Task.sleep(for: unregisterDelay) }
    unregistered.append(token)
  }
}

@MainActor
final class PushRegistrationTests: XCTestCase {
  private let tokenData = Data([0xDE, 0xAD, 0xBE, 0xEF])
  private let tokenHex = "deadbeef"

  private func makeCoordinator(
    status: NotificationAuthorization = .notDetermined,
    environment: PushEnvironment = .sandbox
  ) -> (PushRegistrationCoordinator, FakeNotificationCenter, FakeRemoteRegistrar, FakePushTokenAPI) {
    let center = FakeNotificationCenter(status: status)
    let remote = FakeRemoteRegistrar()
    let api = FakePushTokenAPI()
    let suite = "push-tests-\(UUID().uuidString)"
    let coordinator = PushRegistrationCoordinator(
      center: center, remote: remote, makeAPI: { api }, environment: environment, appVersion: "1.2.3",
      preferences: UserDefaults(suiteName: suite)!)
    return (coordinator, center, remote, api)
  }

  func testSignInAsksProvisionallyThenRegistersTokenWithBuildEnvironment() async {
    let (coordinator, center, remote, api) = makeCoordinator()
    await coordinator.sessionDidStart()
    XCTAssertEqual(center.requests, [.provisional])
    XCTAssertEqual(remote.registerCalls, 1)

    await coordinator.didReceiveDeviceToken(tokenData)
    let registrations = await api.registrations
    XCTAssertEqual(registrations, [.init(token: tokenHex, environment: .sandbox, appVersion: "1.2.3")])
  }

  func testDebugBuildsUseSandbox() {
    #if DEBUG
      XCTAssertEqual(PushEnvironment.forThisBuild, .sandbox)
    #else
      XCTAssertEqual(PushEnvironment.forThisBuild, .production)
    #endif
  }

  func testProductionEnvironmentIsSentWhenConfigured() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized, environment: .production)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    let registrations = await api.registrations
    XCTAssertEqual(registrations.first?.environment, .production)
  }

  func testTokenArrivingBeforeSignInWaitsForTheSession() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.didReceiveDeviceToken(tokenData)
    var registrations = await api.registrations
    XCTAssertTrue(registrations.isEmpty)
    await coordinator.sessionDidStart()
    registrations = await api.registrations
    XCTAssertEqual(registrations.map(\.token), [tokenHex])
  }

  func testTokenChangeReRegistersAndRepeatedTokenDoesNot() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    await coordinator.didReceiveDeviceToken(tokenData)
    await coordinator.didReceiveDeviceToken(Data([0x01, 0x02]))
    let registrations = await api.registrations
    XCTAssertEqual(registrations.map(\.token), [tokenHex, "0102"])
  }

  func testNewSessionRegistersTheSameTokenAgain() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    coordinator.sessionDidEnd()
    await coordinator.sessionDidStart()
    let registrations = await api.registrations
    XCTAssertEqual(registrations.map(\.token), [tokenHex, tokenHex])
  }

  func testSessionDidStartIsIdempotentWhileActive() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    await coordinator.sessionDidStart()  // e.g. unlock after App Lock
    let registrations = await api.registrations
    XCTAssertEqual(registrations.count, 1)
  }

  func testSignOutUnregistersTheToken() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    await coordinator.unregisterBeforeSignOut()
    let unregistered = await api.unregistered
    XCTAssertEqual(unregistered, [tokenHex])

    await coordinator.didReceiveDeviceToken(tokenData)
    let registrations = await api.registrations
    XCTAssertEqual(registrations.count, 1, "no session, so a token callback must not register")
  }

  func testSignOutDoesNotHangOnAStalledUnregister() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    await api.delayUnregister(by: .seconds(30))
    let started = ContinuousClock.now
    await coordinator.unregisterBeforeSignOut(timeout: .milliseconds(50))
    XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
  }

  func testDeniedAuthorizationNeverRegisters() async {
    let (coordinator, center, remote, api) = makeCoordinator(status: .denied)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    await coordinator.userDidReachValueMoment()
    await coordinator.appDidBecomeActive()
    let registrations = await api.registrations
    XCTAssertTrue(registrations.isEmpty)
    XCTAssertEqual(remote.registerCalls, 0)
    XCTAssertTrue(center.requests.isEmpty)
  }

  func testProvisionalDeclinedByTheSystemNeverRegisters() async {
    let (coordinator, center, _, api) = makeCoordinator()
    center.statusAfterProvisional = .denied
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    let registrations = await api.registrations
    XCTAssertTrue(registrations.isEmpty)
  }

  func testTurningNotificationsOffInSettingsUnregisters() async {
    let (coordinator, center, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await coordinator.didReceiveDeviceToken(tokenData)
    center.status = .denied
    await coordinator.appDidBecomeActive()
    let unregistered = await api.unregistered
    XCTAssertEqual(unregistered, [tokenHex])
  }

  func testFailedRegistrationRetriesOnNextForeground() async {
    let (coordinator, _, _, api) = makeCoordinator(status: .authorized)
    await coordinator.sessionDidStart()
    await api.failRegistration(with: APIError.offline)
    await coordinator.didReceiveDeviceToken(tokenData)
    await api.failRegistration(with: nil)
    await coordinator.appDidBecomeActive()
    let registrations = await api.registrations
    XCTAssertEqual(registrations.map(\.token), [tokenHex])
  }

  // MARK: - Prompt strategy and badge

  func testFullPromptIsDeferredToTheValueMomentAndShownOnce() async {
    let (coordinator, center, _, _) = makeCoordinator()
    await coordinator.sessionDidStart()
    XCTAssertEqual(center.requests, [.provisional], "sign-in must not show the system alert")

    await coordinator.userDidReachValueMoment()
    XCTAssertEqual(center.requests, [.provisional, .full])
    XCTAssertEqual(coordinator.authorization, .authorized)

    center.status = .provisional
    await coordinator.userDidReachValueMoment()
    XCTAssertEqual(center.requests, [.provisional, .full], "asked once per install")
  }

  func testValueMomentBeforeSignInDoesNothing() async {
    let (coordinator, center, _, _) = makeCoordinator()
    await coordinator.userDidReachValueMoment()
    XCTAssertTrue(center.requests.isEmpty)
  }

  func testForegroundClearsBadge() async {
    let (coordinator, center, _, _) = makeCoordinator(status: .authorized)
    await coordinator.appDidBecomeActive()
    XCTAssertEqual(center.badgeCounts, [0])
  }
}
