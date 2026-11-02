import B4MKit
import SwiftUI

@main
struct Bike4MindApp: App {
  @State private var auth: AuthController
  @State private var services: AppServices

  init() {
    #if DEBUG
      let environment = ServerEnvironmentStore().load()
    #else
      let environment = ServerEnvironment.production
    #endif
    #if DEBUG
      let tokenStore: any TokenStore =
        FixtureServices.isEnabled ? InMemoryTokenStore(refreshToken: "fixture") : KeychainTokenStore()
    #else
      let tokenStore: any TokenStore = KeychainTokenStore()
    #endif
    let auth = AuthController(environment: environment, tokenStore: tokenStore)
    _auth = State(initialValue: auth)
    _services = State(initialValue: AppServices(auth: auth))
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(auth)
        .environment(services)
    }
  }
}
