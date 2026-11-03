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
    let auth = AuthController(environment: environment, tokenStore: tokenStore)
    _auth = State(initialValue: auth)
    let services = AppServices(auth: auth)
    AppDelegate.services = services
    _services = State(initialValue: services)
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .tint(Tokens.Palette.brand)
        .environment(auth)
        .environment(services)
        .onOpenURL { services.events.handle(url: $0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          guard let url = activity.webpageURL else { return }
          services.events.handle(url: url)
        }
    }
  }
}
