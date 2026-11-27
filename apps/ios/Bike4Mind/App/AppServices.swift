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
    let transcriptCache: SettledTranscriptCache
    let media: MediaClient
    let studio: StudioClient
    let capture: CaptureStack
    let account: AccountClient
    let stepUp: StepUpClient
  }

  @ObservationIgnored private let captureDestinations: any DestinationStore
  @ObservationIgnored private let auth: AuthController
  @ObservationIgnored private let sessionLogger = Logger(subsystem: "com.bike4mind.app", category: "session")
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
  /// Answers an agent's pending approval, on whichever server the app points at.
  let pendingActions: any PendingActionAPI
  /// The server-composed assistant brief, on whichever server the app currently points at.
  let briefs: any BriefAPI
  /// Follow-up memos and their proposed action items, emails and reminders, on whichever server the app points at.
  let briefFollowUps: any BriefFollowUpAPI
  /// The standing instructions the brief composer follows, on whichever server the app points at.
  let instructions: any InstructionAPI
  /// Answers an approval from a notification button.
  let approvalNotifications: ApprovalNotificationHandler
  /// Reads and saves when the server composes the user's brief.
  let briefSchedule: any BriefScheduleAPI
  /// The busy-block brief opt-in and the device calendar it syncs from.
  let busyBlocks: any BusyBlocksAPI
  let busyBlockReader: any BusyBlockReader
  let busyBlockSyncer: BusyBlockSyncer
  /// Which run updates stay quiet after a busy block.
  let interruptionFeedback: any InterruptionFeedbackAPI
  /// Re-syncs busy blocks from a system background refresh while the app is not opened.
  let busyBlockRefresh: BusyBlockBackgroundRefresh
  /// Answers a brief's single decision from a notification button.
  let briefNotifications: BriefNotificationHandler
  /// How many decisions wait on the user, for the lock-screen widget.
  let pendingDecisions: any PendingDecisionAPI
  /// Whether the signed-in account is waiting to be deleted; `RootView` shows the restore screen then.
  let accountStatus = AccountStatus()
  /// Whether the server has refused this build (HTTP 426); `RootView` shows the update screen then.
  let clientUpgrade: ClientUpgradeStatus
  /// The signed-in account's profile, kept for the session; cleared when the session ends (`RootView.endSession`).
  let accountProfiles: AccountProfileStore
  let credits: CreditsViewModel
  /// The Studio model lists, kept for the session; cleared when the session ends (`RootView.endSession`).
  let studioModels: StudioModelCatalog
  /// The deployment's premium voices and this device's pick; empty or unavailable means on-device speech.
  let voiceCatalog: VoiceCatalogModel
  let voiceAPI: any VoiceAPI

  init(auth: AuthController, captureDestinations: any DestinationStore = UserDefaultsDestinationStore()) {
    self.auth = auth
    self.captureDestinations = captureDestinations
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
    let widgets = widgets
    credits = CreditsViewModel(
      fetch: {
        #if DEBUG
          if FixtureServices.isEnabled { return try await FixtureServices.api.creditBalance() }
        #endif
        return try await APIClient(baseURL: auth.environment.baseURL, tokens: auth).creditBalance()
      },
      onBalance: { await widgets.recordCredits($0) })
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

    let pendingActionAPI = ForwardingPendingActionAPI {
      #if DEBUG
        if FixtureServices.isEnabled { return FixtureServices.pendingActionAPI }
      #endif
      return PendingActionClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    pendingActions = pendingActionAPI
    let voiceAPI = ForwardingVoiceAPI { VoiceClient(baseURL: auth.environment.baseURL, tokens: auth) }
    self.voiceAPI = voiceAPI
    voiceCatalog = VoiceCatalogModel(
      wire: voiceAPI,
      store: UserDefaultsVoiceSelectionStore()
    ) {
      guard let userID = await auth.userID() else { return nil }
      return VoiceAccount(userID: userID, baseURL: auth.environment.baseURL)
    }
    let briefAPI = ForwardingBriefAPI {
      #if DEBUG
        if FixtureServices.isEnabled { return FixtureServices.briefAPI }
      #endif
      return BriefClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    briefs = briefAPI
    briefFollowUps = ForwardingBriefFollowUpAPI { BriefClient(baseURL: auth.environment.baseURL, tokens: auth) }
    instructions = ForwardingInstructionAPI {
      #if DEBUG
        if FixtureServices.isEnabled { return FixtureServices.instructionAPI }
      #endif
      return InstructionClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    approvalNotifications = ApprovalNotificationHandler(api: pendingActionAPI, feedback: SystemApprovalFeedback())
    briefSchedule = ForwardingBriefScheduleAPI {
      #if DEBUG
        if FixtureServices.isEnabled { return FixtureServices.briefSchedule }
      #endif
      return BriefScheduleClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    #if DEBUG
      let fixtureBusySessionID = UUID()
    #endif
    let busySession: @MainActor @Sendable () -> BusyBlockSession = {
      #if DEBUG
        if FixtureServices.isEnabled {
          return BusyBlockSession(id: fixtureBusySessionID, api: FixtureServices.busyBlocks, isCurrent: { true })
        }
      #endif
      return BusyBlocksClient.session(for: auth)
    }
    let busyBlocksAPI = ForwardingBusyBlocksAPI { busySession().api }
    busyBlocks = busyBlocksAPI
    busyBlockReader = EventKitBusyBlockReader()
    let syncer = BusyBlockSyncer(api: busyBlocksAPI, reader: busyBlockReader, sessionFactory: busySession)
    busyBlockSyncer = syncer
    interruptionFeedback = ForwardingInterruptionFeedbackAPI {
      #if DEBUG
        if FixtureServices.isEnabled { return FixtureServices.interruptionFeedback }
      #endif
      return InterruptionFeedbackClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    busyBlockRefresh = BusyBlockBackgroundRefresh(
      identifier: SystemBackgroundRefreshScheduler.busyBlockIdentifier, scheduler: SystemBackgroundRefreshScheduler(),
      prepareSync: {
        let admission = syncer.captureAdmission()
        return { await syncer.syncJoiningInFlight(admission: admission) }
      }
    )
    accountProfiles = AccountProfileStore(
      resolveScope: {
        #if DEBUG
          if FixtureServices.isEnabled {
            return AccountProfileStore.Scope(userID: "fixture", environment: auth.environment)
          }
        #endif
        guard let userID = await auth.userID() else { return nil }
        return AccountProfileStore.Scope(userID: userID, environment: auth.environment)
      },
      fetch: { scope in
        #if DEBUG
          if FixtureServices.isEnabled {
            return AccountProfile(firstName: "Alex", displayName: "Alex Rivera", email: "alex@example.com")
          }
        #endif
        let client = AccountClient(baseURL: scope.environment.baseURL, tokens: auth)
        return try? await client.profile(userID: scope.userID)
      })
    briefNotifications = BriefNotificationHandler(
      briefs: briefAPI, pendingActions: pendingActionAPI, feedback: SystemApprovalFeedback())

    studioModels = StudioModelCatalog(
      currentEnvironment: { auth.environment },
      resolveUserID: {
        #if DEBUG
          if FixtureServices.isEnabled { return "fixture" }
        #endif
        return await auth.userID()
      },
      fetch: { kind in
        #if DEBUG
          if FixtureServices.isEnabled { return try await FixtureServices.studio.models(for: kind) }
        #endif
        return try await StudioClient(baseURL: auth.environment.baseURL, tokens: auth).models(for: kind)
      })
    pendingDecisions = ForwardingPendingDecisionAPI {
      PendingDecisionClient(baseURL: auth.environment.baseURL, tokens: auth)
    }

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

    LiveActivityApprovals.answer = { [weak self] target, decision in
      await self?.approvalNotifications.answer(target, decision: decision)
      self?.refreshWidgetPendingDecisions()
    }
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

  /// The profile for the greeting, avatar and Settings header, available on the first frame once it has loaded in
  /// this session; `nil` before that, and after the session ends or the server changes.
  var cachedAccountProfile: AccountProfile? {
    accountProfiles.profile(in: auth.environment)
  }

  /// Loads the profile in the background unless a fresh one is stored; views render `cachedAccountProfile`.
  func refreshAccountProfile() async {
    await accountProfiles.refresh()
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
    let scope: AuthController.SessionEndScope
    do { scope = try auth.sessionEndScope() }
    catch {
      sessionLogger.error("Preparing sign-out failed: \(error, privacy: .public)")
      return
    }
    studioTrackerState?.tracker.reset()
    studioTrackerState = nil
    await questActivities.sessionWillEnd()
    guard auth.isCurrentSession(scope) else { return }
    await agentRunMonitor.stopAll()
    guard auth.isCurrentSession(scope) else { return }
    await push.unregisterBeforeSignOut()
    await auth.signOut(reason: reason, scope: scope)
  }

  /// Capture disk cleanup has completed under the identity lock. Capture the old graph before any await.
  func discardAccountContent() {
    let oldGraph = built
    let termination = auth.completedTermination
    studioTrackerState?.tracker.reset()
    studioTrackerState = nil
    if let environment = oldGraph?.environment {
      UserDefaultsGenerationStore(environment: environment).save([])
    }
    if let identity = termination?.identity, let engine = oldGraph?.capture.engine {
      Task { await engine.releaseOwner(expectedIdentity: identity) }
    }
  }

  var sessionListCache: any SessionListCache { current.cache }

  @ObservationIgnored private var sessionsState: (environment: ServerEnvironment, model: SessionsViewModel)?

  /// The one sessions list the drawer and the Notebooks screen share, so a rename or delete in one shows in
  /// the other. One per server.
  var sessionsModel: SessionsViewModel {
    let environment = auth.environment
    if let sessionsState, sessionsState.environment == environment { return sessionsState.model }
    let widgets = widgets
    let model = SessionsViewModel(
      api: api, cache: sessionListCache,
      onDeleted: { [weak self] sessionID in
        self?.transcriptCache.remove(sessionID: sessionID)
        await widgets.recordDeleted(sessionID: sessionID)
      },
      onRenamed: { sessionID, name in
        await widgets.recordRename(sessionID: sessionID, title: name)
      })
    sessionsState = (environment, model)
    return model
  }
  var transcriptCache: SettledTranscriptCache { current.transcriptCache }
  var sessionHandoff: SessionHandoffClient {
    SessionHandoffClient(baseURL: auth.environment.baseURL, tokens: auth)
  }

  var media: any MediaAPI {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.media }
    #endif
    return current.media
  }

  var studio: any StudioAPI {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.studio }
    #endif
    return current.studio
  }

  /// Uploads a frame grabbed from a video so it can be edited or animated.
  var frameUploader: FrameUploader {
    #if DEBUG
      if FixtureServices.isEnabled { return FixtureServices.frameUploader }
    #endif
    return FrameUploader(
      capture: CaptureClient(baseURL: auth.environment.baseURL, tokens: auth), media: media,
      put: Self.presignedPut)
  }

  /// Hands a scanned bill to the assistant. The scan is uploaded with the user's own token, like any capture.
  func obligationHandoffModel(file: URL, text: String) -> ObligationHandoffModel {
    ObligationHandoffModel(
      file: file, text: text, api: CaptureClient(baseURL: auth.environment.baseURL, tokens: auth),
      destinations: capture.destinations, put: Self.presignedPut)
  }

  /// The PUT carries no `Authorization` header: the presigned signature is the credential.
  private static let presignedPut: FrameUploader.Put = { url, data, contentType in
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    // Create-only: the URL names a freshly minted key, so the PUT must never overwrite one.
    request.setValue("*", forHTTPHeaderField: "If-None-Match")
    let (_, response) = try await URLSession.shared.upload(for: request, from: data)
    guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
      throw APIError.malformedResponse
    }
  }

  @ObservationIgnored private var studioTrackerState: (environment: ServerEnvironment, tracker: GenerationTracker)?

  /// Follows Studio generations app-wide, so leaving Studio does not lose track of them. One per server.
  var studioTracker: GenerationTracker {
    let environment = auth.environment
    if let studioTrackerState, studioTrackerState.environment == environment { return studioTrackerState.tracker }
    studioTrackerState?.tracker.stop()
    let tracker = GenerationTracker(
      api: studio, realtime: realtime, store: UserDefaultsGenerationStore(environment: environment))
    tracker.resume()
    studioTrackerState = (environment, tracker)
    return tracker
  }

  @ObservationIgnored private var mediaFirstPagesState: (environment: ServerEnvironment, store: MediaFirstPageStore)?

  /// Page 1 of the media list for the gallery and the "Morph into" picker. One per server, so it survives
  /// leaving Studio and re-opening it; emptied by `RootView.endSession()`.
  var mediaFirstPages: MediaFirstPageStore {
    let environment = auth.environment
    if let mediaFirstPagesState, mediaFirstPagesState.environment == environment {
      return mediaFirstPagesState.store
    }
    var cache: any MediaListCache = FileMediaListCache(
      directory: FileSessionListCache.defaultDirectory(), environment: environment)
    #if DEBUG
      if FixtureServices.isEnabled { cache = InMemoryMediaListCache() }
    #endif
    let store = MediaFirstPageStore(api: media, cache: cache)
    mediaFirstPagesState = (environment, store)
    return store
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

  /// Re-reads the shared balance after a settled turn and on foreground, regardless of the Settings TTL.
  func refreshWidgetCredits() {
    let credits = credits
    Task { await credits.load(force: true) }
  }

  /// Re-reads the decisions-waiting count for the lock-screen widget: on foreground, when a turn settles, after
  /// the brief loads and after an approval is answered. Fixture runs keep the canned snapshot.
  func refreshWidgetPendingDecisions() {
    #if DEBUG
      if FixtureServices.isEnabled { return }
    #endif
    let api = pendingDecisions
    let widgets = widgets
    Task {
      do {
        await widgets.recordPendingDecisions(try await api.pendingDecisionCount())
      } catch {
        // The widget keeps its last count; approvals in it still lapse on the widget's own clock.
        AppServices.logger.error(
          "Decisions widget refresh failed: \(String(describing: error), privacy: .public)")
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
    let transcriptCache = SettledTranscriptCache()
    // The share extension reads the server from the App Group, so it always follows the app's choice.
    SharedServerEnvironment.store().save(environment)
    let fresh = Graph(
      environment: environment,
      api: APIClient(baseURL: environment.baseURL, tokens: auth),
      realtime: WSClient(
        handshake: RealtimeHandshake(baseURL: environment.baseURL, tokens: auth),
        tokenRotations: { await auth.accessTokenRotations() }),
      cache: FileSessionListCache(directory: FileSessionListCache.defaultDirectory(), environment: environment),
      transcriptCache: transcriptCache,
      media: MediaClient(baseURL: environment.baseURL, tokens: auth),
      studio: StudioClient(baseURL: environment.baseURL, tokens: auth),
      capture: .live(
        baseURL: environment.baseURL, tokens: auth, ownIdentifier: BackgroundSessionIdentifier.app,
        destinationStore: captureDestinations, didSendToSession: { id in await transcriptCache.remove(sessionID: id) }),
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

/// Routes voice calls to whichever server the app currently points at.
struct ForwardingVoiceAPI: VoiceAPI {
  let provider: @MainActor @Sendable () -> any VoiceAPI

  func voiceSessionsEnabled() async throws -> Bool { try await provider().voiceSessionsEnabled() }
  func listVoices() async throws -> [VoiceOption] { try await provider().listVoices() }
  func synthesizeSpeech(text: String, voiceID: String) async throws -> Data {
    try await provider().synthesizeSpeech(text: text, voiceID: voiceID)
  }
}

/// Routes approval answers to whichever server the app currently points at (it can change in debug builds).
struct ForwardingPendingActionAPI: PendingActionAPI {
  let provider: @MainActor @Sendable () -> any PendingActionAPI

  func respond(to target: PendingActionTarget, decision: PendingActionDecision) async throws -> PendingActionResult {
    try await provider().respond(to: target, decision: decision)
  }
}

struct ForwardingBriefScheduleAPI: BriefScheduleAPI {
  let provider: @MainActor @Sendable () -> any BriefScheduleAPI

  func schedule() async throws -> BriefSchedule? {
    try await provider().schedule()
  }

  func save(_ schedule: BriefSchedule) async throws -> BriefSchedule {
    try await provider().save(schedule)
  }
}

struct ForwardingBusyBlocksAPI: BusyBlocksAPI {
  let provider: @MainActor @Sendable () -> any BusyBlocksAPI

  func state() async throws -> BusyBlocksState {
    try await provider().state()
  }

  func save(enabled: Bool, blocks: [BusyBlock]) async throws -> BusyBlocksState {
    try await provider().save(enabled: enabled, blocks: blocks)
  }
}

struct ForwardingInterruptionFeedbackAPI: InterruptionFeedbackAPI {
  let provider: @MainActor @Sendable () -> any InterruptionFeedbackAPI

  func feedback() async throws -> InterruptionFeedback {
    try await provider().feedback()
  }

  func save(_ patch: InterruptionFeedback) async throws -> InterruptionFeedback {
    try await provider().save(patch)
  }
}

/// Routes the decisions-waiting count to whichever server the app currently points at.
struct ForwardingPendingDecisionAPI: PendingDecisionAPI {
  let provider: @MainActor @Sendable () -> any PendingDecisionAPI

  func pendingDecisionCount() async throws -> PendingDecisionCount {
    try await provider().pendingDecisionCount()
  }
}

/// Routes brief calls to whichever server the app currently points at (it can change in debug builds).
struct ForwardingBriefAPI: BriefAPI {
  let provider: @MainActor @Sendable () -> any BriefAPI

  func compose() async throws -> Brief {
    try await provider().compose()
  }

  func list() async throws -> [Brief] {
    try await provider().list()
  }

  func brief(id: String) async throws -> Brief {
    try await provider().brief(id: id)
  }

  func reply(briefID: String, decisionID: String, text: String, choiceIndex: Int?) async throws -> BriefReplyResult {
    try await provider().reply(briefID: briefID, decisionID: decisionID, text: text, choiceIndex: choiceIndex)
  }
}

/// Routes follow-up calls to whichever server the app currently points at (it can change in debug builds).
struct ForwardingBriefFollowUpAPI: BriefFollowUpAPI {
  let provider: @MainActor @Sendable () -> any BriefFollowUpAPI

  func followUp(transcript: String, timeZone: String?) async throws -> Brief {
    try await provider().followUp(transcript: transcript, timeZone: timeZone)
  }

  func editDecision(briefID: String, decisionID: String, edit: BriefDecisionEdit) async throws -> BriefDecision {
    try await provider().editDecision(briefID: briefID, decisionID: decisionID, edit: edit)
  }

  func resolveDecision(
    briefID: String, decisionID: String, outcome: BriefDecisionOutcome
  ) async throws -> BriefDecision {
    try await provider().resolveDecision(briefID: briefID, decisionID: decisionID, outcome: outcome)
  }
}

/// Routes instruction calls to whichever server the app currently points at (it can change in debug builds).
struct ForwardingInstructionAPI: InstructionAPI {
  let provider: @MainActor @Sendable () -> any InstructionAPI

  func list() async throws -> [AssistantInstruction] {
    try await provider().list()
  }

  func add(text: String) async throws -> AssistantInstruction {
    try await provider().add(text: text)
  }

  func remove(id: String) async throws {
    try await provider().remove(id: id)
  }
}
