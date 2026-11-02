import B4MKit
import Foundation
import Observation
import UIKit
import WidgetKit

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

  init(auth: AuthController) {
    self.auth = auth
    let registrar = SystemRemoteNotificationRegistrar()
    systemSettings = registrar
    // TODO: swap for a server-backed service once userSettings.pushNotifications has a read/write endpoint.
    notificationPrefs = LocalNotificationPrefsService()

    // Fixture runs (UI work, screenshots) have no session, so they must never call the push endpoints.
    var makeAPI: @MainActor () -> any PushTokenAPI = {
      PushTokenClient(baseURL: auth.environment.baseURL, tokens: auth)
    }
    #if DEBUG
      if FixtureServices.isEnabled { makeAPI = { FixtureServices.pushTokenAPI } }
    #endif
    widgets = WidgetSnapshotRecorder(
      store: FileWidgetSnapshotStore.appGroup(), reloader: SystemWidgetTimelineReloader())
    push = PushRegistrationCoordinator(center: SystemNotificationCenter(), remote: registrar, makeAPI: makeAPI)

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
      guard let balance = try? await api.creditBalance() else { return }
      await widgets.recordCredits(balance)
    }
  }

  /// A fresh launch knows of no running agent; and fixture runs seed the widgets with canned data.
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

  private var current: Graph {
    if let built, built.environment == auth.environment { return built }
    if let stale = built?.realtime {
      Task { await stale.stop() }
    }
    let environment = auth.environment
    let auth = self.auth
    let fresh = Graph(
      environment: environment,
      api: APIClient(baseURL: environment.baseURL, tokens: auth),
      realtime: WSClient(
        handshake: RealtimeHandshake(baseURL: environment.baseURL, tokens: auth),
        tokenRotations: { await auth.accessTokenRotations() }),
      cache: FileSessionListCache(directory: FileSessionListCache.defaultDirectory(), environment: environment),
      media: MediaClient(baseURL: environment.baseURL, tokens: auth)
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
