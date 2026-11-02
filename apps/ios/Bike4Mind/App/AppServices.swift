import B4MKit
import Foundation
import Observation
import UIKit

/// Builds and shares the signed-in object graph: the API client and the on-disk cache for the
/// current server. Rebuilt when the server changes, because tokens and cached rows belong to the
/// deployment that issued them.
@MainActor
@Observable
final class AppServices {
  @ObservationIgnored private let auth: AuthController
  @ObservationIgnored private var built: (environment: ServerEnvironment, api: APIClient, cache: FileSessionListCache)?

  let navigator = AppNavigator()
  let push: PushRegistrationCoordinator
  let notificationPrefs: any NotificationPrefsService
  let systemSettings: any SystemSettingsOpening
  let events: IncomingEventHandler

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
  var sessionListCache: any SessionListCache { current.cache }

  private var current: (environment: ServerEnvironment, api: APIClient, cache: FileSessionListCache) {
    if let built, built.environment == auth.environment { return built }
    let environment = auth.environment
    let fresh = (
      environment: environment,
      api: APIClient(baseURL: environment.baseURL, tokens: auth),
      cache: FileSessionListCache(directory: FileSessionListCache.defaultDirectory(), environment: environment)
    )
    built = fresh
    return fresh
  }
}
