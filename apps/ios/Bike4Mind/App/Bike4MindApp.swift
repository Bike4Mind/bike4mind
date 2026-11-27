import B4MKit
import SwiftUI

@main
struct Bike4MindApp: App {
  @State private var auth: AuthController
  @State private var services: AppServices
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  init() {
    #if DEBUG
      let environment = ServerEnvironmentStore().load()
    #else
      let environment = ServerEnvironment.production
    #endif
    #if DEBUG
      let tokenStore: any TokenStore =
        FixtureServices.isEnabled
        ? InMemoryTokenStore(refreshToken: "fixture") : KeychainTokenStore(accessGroup: KeychainAccessGroup.resolved())
    #else
      let tokenStore: any TokenStore = KeychainTokenStore(accessGroup: KeychainAccessGroup.resolved())
    #endif
    let destinations = UserDefaultsDestinationStore()
    let captureCleanup = CaptureSessionCleanup(destinations: destinations)
    // Release always signs in as the first-party client on the claimed universal link. DEBUG uses the
    // development client (custom scheme) on non-production servers. See README "Sign-in callback".
    #if DEBUG
      let auth = AuthController(
        environment: environment, tokenStore: tokenStore, sessionEndCleanup: captureCleanup.perform, oauthConfiguration: OAuthConfiguration.debugBuild(for:))
    #else
      let auth = AuthController(environment: environment, tokenStore: tokenStore, sessionEndCleanup: captureCleanup.perform)
    #endif
    _auth = State(initialValue: auth)
    let services = AppServices(auth: auth, captureDestinations: destinations)
    AppDelegate.services = services
    _services = State(initialValue: services)
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .tint(Tokens.Palette.brand)
        .font(Tokens.Typography.body)
        .environment(auth)
        .environment(services)
        .onOpenURL { services.events.handle(url: $0) }
        #if DEBUG
          .task {
            if FixtureServices.isEnabled, let link = FixtureServices.initialLink { services.events.handle(url: link) }
          }
        #endif
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          guard let url = activity.webpageURL else { return }
          services.events.handle(url: url)
        }
    }
  }
}
