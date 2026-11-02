import B4MKit
import Foundation
import Observation

/// Builds and shares the signed-in object graph: the API client and the on-disk cache for the
/// current server. Rebuilt when the server changes, because tokens and cached rows belong to the
/// deployment that issued them.
@MainActor
@Observable
final class AppServices {
  @ObservationIgnored private let auth: AuthController
  @ObservationIgnored private var built: (environment: ServerEnvironment, api: APIClient, cache: FileSessionListCache)?

  init(auth: AuthController) {
    self.auth = auth
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
