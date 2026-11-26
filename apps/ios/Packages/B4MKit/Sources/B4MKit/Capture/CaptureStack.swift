import Foundation

/// Everything the capture UI needs, assembled once so the app and the share extension wire it identically.
/// The extension target stays a thin shell around this.
public struct CaptureStack: Sendable {
  /// `nil` in fixture mode: there is nothing to resume or reattach.
  public let engine: CaptureEngine?
  /// What the upload indicator watches: the engine, or scripted jobs in fixture mode.
  public let jobs: any CaptureJobTracking
  public let destinations: any DestinationSource
  public let submitter: any CaptureSubmitting
  public let transcription: any TranscriptionService
  public let destinationStore: any DestinationStore
  public let delegator: (any DelegationSubmitting)?

  public init(
    engine: CaptureEngine?, destinations: any DestinationSource, submitter: any CaptureSubmitting,
    transcription: any TranscriptionService, destinationStore: any DestinationStore,
    jobs: any CaptureJobTracking, delegator: (any DelegationSubmitting)? = nil
  ) {
    self.delegator = delegator
    self.engine = engine
    self.jobs = jobs
    self.destinations = destinations
    self.submitter = submitter
    self.transcription = transcription
    self.destinationStore = destinationStore
  }

  /// The real services for one server.
  /// - Parameter ownIdentifier: the background session this process owns (`BackgroundSessionIdentifier`).
  public static func live(
    baseURL: URL, tokens: any AccessTokenProviding, ownIdentifier: String,
    directory: URL = SharedContainer.directory(),
    destinationStore: any DestinationStore = UserDefaultsDestinationStore(),
    didSendToSession: (@Sendable (String) async -> Void)? = nil
  ) -> CaptureStack {
    let capture = CaptureClient(baseURL: baseURL, tokens: tokens)
    let engine = CaptureEngine(
      store: FileUploadJobStore(directory: directory), api: capture, ownIdentifier: ownIdentifier,
      makeUploader: { URLSessionBackgroundUploader(identifier: $0) }, didSendToSession: didSendToSession,
      currentOwner: {
        guard let token = try? await tokens.accessToken(),
          let userID = AccountProfile.userID(fromAccessToken: token)
        else { return nil }
        return CaptureOwner(userID: userID, baseURL: baseURL)
      })
    return CaptureStack(
      engine: engine,
      destinations: RemoteDestinationSource(capture: capture, api: APIClient(baseURL: baseURL, tokens: tokens)),
      submitter: engine,
      transcription: TranscriptionClient(baseURL: baseURL, tokens: tokens),
      destinationStore: destinationStore, jobs: engine, delegator: capture)
  }

  /// Offline stand-ins for `B4M_UI_FIXTURES=1`.
  public static func fixture(destinationStore: any DestinationStore = InMemoryDestinationStore()) -> CaptureStack {
    CaptureStack(
      engine: nil, destinations: CaptureFixtures.destinationSource, submitter: CaptureFixtures.submitter,
      transcription: CaptureFixtures.transcription, destinationStore: destinationStore, jobs: CaptureFixtures.jobs,
      delegator: CaptureFixtures.delegator)
  }

  /// Session end: drops the remembered destination and, unless `keepingJobs`, queued captures and their staged
  /// files. Kept jobs carry their owner, so the next sign-in sends them only if the same account returns.
  public func signOut(keepingJobs: Bool = false) async {
    if keepingJobs {
      await engine?.releaseOwner()
    } else {
      await engine?.discardAll()
    }
    destinationStore.forget()
  }

  @MainActor
  public func composerModel(items: [ShareItem]) -> ShareComposerModel {
    ShareComposerModel(
      items: items, source: destinations, submitter: submitter, store: destinationStore, delegator: delegator)
  }
}

/// The server choice shared between the app and the share extension through the App Group, so a
/// DEBUG-picked stage applies to both. Release builds are always production.
public enum SharedServerEnvironment {
  public static func store() -> ServerEnvironmentStore {
    ServerEnvironmentStore(suiteName: SharedContainer.appGroupIdentifier)
  }
}
