import B4MKit
import SwiftUI

@main
struct Bike4MindApp: App {
  @State private var auth: AuthController

  init() {
    #if DEBUG
      let environment = ServerEnvironmentStore().load()
    #else
      let environment = ServerEnvironment.production
    #endif
    _auth = State(initialValue: AuthController(environment: environment, tokenStore: KeychainTokenStore()))
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(auth)
    }
  }
}
