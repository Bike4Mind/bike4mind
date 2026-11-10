import B4MKit
import Foundation
import Observation
import UIKit
import WidgetKit
import os

/// Builds and shares the signed-in object graph: the API client, the realtime socket and the on-disk
/// cache for the current server. Rebuilt when the server changes, because tokens, sockets and cached
/// rows belong to the deployment that issued them.
@MainActor
@Observable
final class AppServices {
  private struct Graph {
    let environment: ServerEnvironment
    let api: APIClient
    let realtime: WSClient
    let cache: FileSessionListCache
    let media: MediaClient
    let capture: CaptureStack
    let account: AccountClient
    let stepUp: StepUpClient
  }

  @ObservationIgnored private let auth: AuthController
  @ObservationIgnored private var built: Graph?

  let navigator = AppNavigator()
  let push: PushRegistrationCoordinator
  let notificationPrefs: any NotificationPrefsService
  let systemSettings: any SystemSettingsOpening
  let events: IncomingEventHandler
  /// Writes what the widgets show into the shared app-group snapshot (see `WidgetSnapshot`).
  let widgets: WidgetSnapshotRecorder
  /// Every Live Activity the app has running, one per quest.
  let questActivities: QuestActivityManager
  /// Follows started agent runs so their Live Activity stays current while the app is open.
  let agentRunMonitor: AgentRunMonitor
  /// Starts a fire-and-forget agent run with its own Live Activity.
  let agentRuns: any AgentRunStarting
  /// Whether the signed-in account is waiting to be deleted; `RootView` shows the restore screen then.
  let accountStatus = AccountStatus()
  /// Whether the server has refused this build (HTTP 426); `RootView` shows the update screen then.
  let clientUpgrade: ClientUpgradeStatus

  init(auth: AuthController) {
    self.auth = auth
    clientUpgrade = ClientUpgradeStatus { [auth] in
      try await ClientVersionProbe(baseURL: auth.environment.baseURL).check()
    }
    let registrar = SystemRemoteNotificationRegistrar()
    systemSettings = registrar
    // TODO: swap for a server-backed service once userSettings.pushNotifications has a read/write endpoint.
    notificationPrefs = LocalNotificationPrefsService()

    // Fixture runs (UI work, screenshots) have no session, so they must never call the push endpoints.
    var makeAPI: PushTokenAPIProvider = {
      PushTokenClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    #if DEBUG
      if FixtureServices.isEnabled { makeAPI = { FixtureServices.pushTokenAPI } }
    #endif
    widgets = WidgetSnapshotRecorder(
      store: FileWidgetSnapshotStore.appGroup(), reloader: SystemWidgetTimelineReloader())
    push = PushRegistrationCoordinator(center: SystemNotificationCenter(), remote: registrar, makeAPI: makeAPI)

    let activities = QuestActivityManager(host: ActivityKitHost(), makeTokenAPI: makeAPI)
    questActivities = activities
    var monitorPolicy = AgentRunMonitor.Policy()
    #if DEBUG
      if FixtureServices.isEnabled { monitorPolicy.interval = .seconds(2) }
    #endif
    let agentRunAPI = ForwardingAgentRunAPI {
      #if DEBUG
        if FixtureServices.isEnabled { return FixtureServices.agentRunAPI }
      #endif
      return AgentRunClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    let monitor = AgentRunMonitor(api: agentRunAPI, tracker: activities, policy: monitorPolicy)
    agentRunMonitor = monitor
    agentRuns = AgentRunService(api: agentRunAPI, tracker: activities, monitor: monitor)

    #if DEBUG
      if FixtureServices.isEnabled, FixtureServices.accountScenario == .pending {
        accountStatus.receive(AccountDeletionNotice(scheduledFor: Date().addingTimeInterval(29 * 86_400)))
      }
    #endif

    let navigator = navigator
    events = IncomingEventHandler(
      navigator: navigator,
      isShellReady: { auth.state == .signedIn },
      isAppActive: { UIApplication.shared.applicationState == .active }
    )
  }

  var api: any B4MAPI {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.api }
    #endif
    return current.api
  }

  var realtime: any RealtimeClient {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.realtime }
    #endif
    return current.realtime
  }

  var account: any AccountAPI {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.account }
    #endif
    return current.account
  }

  /// The signed-in account's first name for greetings; fixture runs have no session, so they get a stand-in.
  func accountFirstName() async -> String? {
    #if DEBUG
      if FixtureServices.isEnabled { return "Alex" }
    #endif
    return await auth.firstName()
  }

  var stepUp: any StepUpAPI {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.stepUp }
    #endif
    return current.stepUp
  }

  /// Ends the session everywhere the app can reach: Live Activities, agent run polling, the push token and
  /// finally the tokens. The unregister call needs a live session, so it runs before the session is torn down.
  func signOutEverywhere(reason: AuthController.SignOutReason = .userInitiated) async {
    await questActivities.sessionWillEnd()
    await agentRunMonitor.stopAll()
    await push.unregisterBeforeSignOut()
    await auth.signOut(reason: reason)
  }

  var sessionListCache: any SessionListCache { current.cache }

  var media: any MediaAPI {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.media }
    #endif
    return current.media
  }

  /// Called when the gallery learns of a newer generated image; keeps the "Latest generation" widget current.
  var latestGeneration: @Sendable (MediaItem) async -> Void {
    let publisher = LatestGenerationPublisher(recorder: widgets)
    return { await publisher.publish($0) }
  }

  /// Chat turns for one session changed: refresh the running-agents widget.
  func chatTurnsChanged(sessionID: String, title: String, turns: [QuestTurn]) {
    let widgets = widgets
    Task { await widgets.recordTurns(sessionID: sessionID, sessionTitle: title, turns: turns) }
  }

  /// Re-reads the balance for the Credits widget: after a chat turn settles (it spends credits) and when
  /// the app comes to the foreground.
  func refreshWidgetCredits() {
    let api = api
    let widgets = widgets
    Task {
      do {
        await widgets.recordCredits(try await api.creditBalance())
      } catch {
        // The widget keeps its last balance; the next foreground or settled turn tries again.
        AppServices.logger.error("Credits widget refresh failed: \(String(describing: error), privacy: .public)")
      }
    }
  }

  nonisolated static let logger = Logger(subsystem: "com.bike4mind.app", category: "app")

  /// A fresh launch or sign-in knows of no running agent, and fixture runs seed the widgets with canned data.
  /// Must not run on an App Lock unlock (it would clear a run in flight); `AuthLifecycle` gates that.
  func prepareWidgets() {
    let widgets = widgets
    #if DEBUG
      if FixtureServices.isEnabled {
        Task { await widgets.replace(with: .fixture()) }
        return
      }
    #endif
    Task { await widgets.clearRunning() }
  }
  /// Share, camera and voice capture for the current server; fixtures under `B4M_UI_FIXTURES=1`.
  var capture: CaptureStack {
    #if DEBUG
      if FixtureServices.isEnabled { return fixtureCapture }
    #endif
    return current.capture
  }

  /// Called at launch and on foreground: finishes uploads the share extension or an earlier run left behind.
  func resumeCapture() {
    guard auth.state == .signedIn || auth.state == .locked, let engine = capture.engine else { return }
    Task { await engine.resume() }
  }

  /// `application(_:handleEventsForBackgroundURLSession:)`: the system relaunched the app for upload events.
  func reattachCaptureSession(identifier: String, completion: @escaping @Sendable () -> Void) {
    guard let engine = capture.engine else { return completion() }
    Task { await engine.reattach(identifier: identifier, systemCompletion: completion) }
  }

  @ObservationIgnored private let fixtureCapture = CaptureStack.fixture()

  private var current: Graph {
    if let built, built.environment == auth.environment { return built }
    if let stale = built?.realtime {
      Task { await stale.stop() }
    }
    let environment = auth.environment
    let auth = self.auth
    // The share extension reads the server from the App Group, so it always follows the app's choice.
    SharedServerEnvironment.store().save(environment)
    let fresh = Graph(
      environment: environment,
      api: APIClient(baseURL: environment.baseURL, tokens: auth),
      realtime: WSClient(
        handshake: RealtimeHandshake(baseURL: environment.baseURL, tokens: auth),
        tokenRotations: { await auth.accessTokenRotations() }),
      cache: FileSessionListCache(directory: FileSessionListCache.defaultDirectory(), environment: environment),
      media: MediaClient(baseURL: environment.baseURL, tokens: auth),
      capture: .live(baseURL: environment.baseURL, tokens: auth, ownIdentifier: BackgroundSessionIdentifier.app),
      account: AccountClient(baseURL: environment.baseURL, tokens: auth),
      stepUp: StepUpClient(baseURL: environment.baseURL, tokens: auth)
    )
    built = fresh
    return fresh
  }
}

/// Reloads widget timelines through WidgetKit. Lives in the app target because B4MKit stays WidgetKit-free.
struct SystemWidgetTimelineReloader: WidgetTimelineReloading {
  func reload(kinds: [String]) {
    for kind in kinds { WidgetCenter.shared.reloadTimelines(ofKind: kind) }
  }
}

/// Routes agent-run calls to whichever server the app currently points at (it can change in debug builds),
/// so the long-lived run service and monitor never hold a client for a stale deployment.
struct ForwardingAgentRunAPI: AgentRunAPI {
  let provider: @MainActor @Sendable () -> any AgentRunAPI

  func startRun(sessionID: String, message: String) async throws -> AgentRunReceipt {
    try await provider().startRun(sessionID: sessionID, message: message)
  }

  func run(id: String) async throws -> AgentRunStatus {
    try await provider().run(id: id)
  }
}
