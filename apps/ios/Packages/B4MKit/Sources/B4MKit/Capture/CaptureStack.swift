import Foundation
import os

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
  private let makeComposer: (@MainActor @Sendable ([ShareItem]) -> ShareComposerModel)?

  public init(
    engine: CaptureEngine?, destinations: any DestinationSource, submitter: any CaptureSubmitting,
    transcription: any TranscriptionService, destinationStore: any DestinationStore,
    jobs: any CaptureJobTracking, delegator: (any DelegationSubmitting)? = nil,
    makeComposer: (@MainActor @Sendable ([ShareItem]) -> ShareComposerModel)? = nil
  ) {
    self.delegator = delegator
    self.engine = engine
    self.jobs = jobs
    self.destinations = destinations
    self.submitter = submitter
    self.transcription = transcription
    self.destinationStore = destinationStore
    self.makeComposer = makeComposer
  }

  /// The real services for one server.
  /// - Parameter ownIdentifier: the background session this process owns (`BackgroundSessionIdentifier`).
  public static func live(
    baseURL: URL, tokens: any SharedSessionAdmissionProviding, ownIdentifier: String,
    directory: URL = SharedContainer.directory(),
    destinationStore: any DestinationStore = UserDefaultsDestinationStore(),
    didSendToSession: (@Sendable (String) async -> Void)? = nil,
    transport: any HTTPTransport = URLSessionTransport(),
    makeUploader: @escaping @Sendable (String) -> any BackgroundUploading = { URLSessionBackgroundUploader(identifier: $0) }
  ) -> CaptureStack {
    let capture = CaptureClient(baseURL: baseURL, tokens: tokens, transport: transport)
    let engine = CaptureEngine(
      store: FileUploadJobStore(directory: directory), api: capture, ownIdentifier: ownIdentifier,
      makeUploader: makeUploader, didSendToSession: didSendToSession,
      currentAdmission: {
        let admission = try await tokens.captureAdmission()
        guard admission.identity.baseURL == baseURL else { throw SharedSessionError.changed }
        return admission
      },
      makeAdmittedAPI: { admission in
        CaptureClient(baseURL: baseURL, tokens: AdmittedAccessTokens(tokens: tokens, admission: admission), transport: transport)
      })
    return CaptureStack(
      engine: engine,
      destinations: RemoteDestinationSource(capture: capture, api: APIClient(baseURL: baseURL, tokens: tokens, transport: transport)),
      submitter: engine,
      transcription: TranscriptionClient(baseURL: baseURL, tokens: tokens, transport: transport),
      destinationStore: destinationStore, jobs: engine, delegator: capture,
      makeComposer: { items in
        let result = Result {
          let admission = try tokens.captureAdmission()
          guard admission.identity.baseURL == baseURL else { throw SharedSessionError.changed }
          return admission
        }
        let boundTokens: any AccessTokenProviding
        switch result {
        case .success(let admission): boundTokens = AdmittedAccessTokens(tokens: tokens, admission: admission)
        case .failure(let error): boundTokens = UnavailableCaptureTokens(error: error)
        }
        let boundCapture = CaptureClient(baseURL: baseURL, tokens: boundTokens, transport: transport)
        return ShareComposerModel(
          items: items,
          source: RemoteDestinationSource(capture: boundCapture, api: APIClient(baseURL: baseURL, tokens: boundTokens, transport: transport)),
          submitter: AdmittedCaptureSubmitter(engine: engine, admission: result),
          store: AdmittedDestinationStore(store: destinationStore, admission: result), delegator: boundCapture)
      })
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
    if let makeComposer { return makeComposer(items) }
    return ShareComposerModel(
      items: items, source: destinations, submitter: submitter, store: destinationStore, delegator: delegator)
  }
}

/// Synchronous disk cleanup shared by the app and extension, before a replacement session is published.
public struct CaptureSessionCleanup: Sendable {
  private let store: FileUploadJobStore
  private let destinations: any DestinationStore

  public init(directory: URL = SharedContainer.directory(), destinations: any DestinationStore) {
    store = FileUploadJobStore(directory: directory)
    self.destinations = destinations
  }

  public func perform(_ termination: SessionTermination) throws {
    if termination.reason != .sessionEnded {
      let owner = termination.userID.map { CaptureOwner(userID: $0, baseURL: termination.baseURL) }
      try store.removeForSessionEnd(owner: owner)
    }
    destinations.forget()
  }
}

struct AdmittedDestinationStore: DestinationStore {
  let store: any DestinationStore
  let admission: Result<SharedSessionAdmission, any Error>
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "capture")

  func lastDestination() -> CaptureDestination? {
    withAdmission(nil) { store.lastDestination() }
  }

  func remember(_ destination: CaptureDestination) {
    withAdmission(()) { store.remember(destination) }
  }

  func forget() {
    withAdmission(()) { store.forget() }
  }

  private func withAdmission<Value>(_ fallback: Value, _ operation: () -> Value) -> Value {
    do { return try admission.get().withCurrent(operation) }
    catch {
      logger.debug("Capture destination session is no longer available")
      return fallback
    }
  }
}

private struct UnavailableCaptureTokens: AccessTokenProviding {
  let error: any Error
  func accessToken() async throws -> String { throw error }
  func invalidateAccessToken(_ token: String) async {}
  func sessionRejected() async {}
}

private struct AdmittedCaptureSubmitter: CaptureSubmitting {
  let engine: CaptureEngine
  let admission: Result<SharedSessionAdmission, any Error>
  func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?) async throws -> [UploadJob] {
    try await engine.submit(items, to: destination, note: note, admission: admission.get())
  }
  func retry(jobID: UUID) async {
    guard case .success(let admission) = admission else { return }
    await engine.retry(jobID: jobID, admission: admission)
  }
  func discard(jobID: UUID) async {
    guard case .success(let admission) = admission else { return }
    await engine.discard(jobID: jobID, admission: admission)
  }
  func jobs() async -> [UploadJob] {
    guard case .success(let admission) = admission else { return [] }
    return await engine.jobs(admission: admission)
  }
}

/// The server choice shared between the app and the share extension through the App Group, so a
/// DEBUG-picked stage applies to both. Release builds are always production.
public enum SharedServerEnvironment {
  public static func store() -> ServerEnvironmentStore {
    ServerEnvironmentStore(suiteName: SharedContainer.appGroupIdentifier)
  }
}
