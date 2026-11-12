import Foundation

/// Offline stand-ins for every capture service, so `B4M_UI_FIXTURES=1` exercises the share and capture UI
/// (in the app and in the share extension) with no server.
public enum CaptureFixtures {
  public static let lakes = [
    LakeSummary(id: "fixture-lake-research", name: "Research", fileCount: 42, isBuiltIn: false),
    LakeSummary(id: "fixture-lake-receipts", name: "Receipts", fileCount: 9, isBuiltIn: false),
  ]

  public static let destinationSource: any DestinationSource = FixtureDestinationSource()
  /// Both the submitter and the job tracker, so a fixture send shows up in the app's upload indicator.
  public static let jobs = FixtureCaptureJobs()
  public static let submitter: any CaptureSubmitting = jobs
  public static let transcription: any TranscriptionService = FixtureTranscription()
  public static let recorder: any AudioRecording = FixtureRecorder()

  private struct FixtureDestinationSource: DestinationSource {
    func lakes() async throws -> [LakeSummary] { CaptureFixtures.lakes }

    func sessions() async throws -> [SessionSummary] {
      let now = Date()
      return ["Trip planning", "Quarterly metrics review", "Recipe ideas"].enumerated().map { index, name in
        SessionSummary(
          id: "fixture-\(index)", name: name, lastUsedModel: nil,
          firstCreated: now.addingTimeInterval(-86_400), lastUpdated: now.addingTimeInterval(-Double(index) * 3_600))
      }
    }
  }

  private struct FixtureTranscription: TranscriptionService {
    func transcribe(audioFile: URL, mimeType: String) async throws -> String {
      try? await Task.sleep(for: .milliseconds(500))
      return "Remember to follow up on the quarterly numbers before Friday."
    }
  }

  private struct FixtureRecorder: AudioRecording {
    func permission() async -> MicrophonePermission { .granted }
    func requestPermission() async -> Bool { true }
    func start() async throws {}

    func stop() async throws -> VoiceRecording {
      let url = FileManager.default.temporaryDirectory.appending(path: "fixture-\(UUID().uuidString).m4a")
      try Data([0]).write(to: url)
      return VoiceRecording(fileURL: url, duration: 3)
    }

    func cancel() async {}
  }
}

/// Scripted capture jobs for `B4M_UI_FIXTURES=1`: every submitted item walks `queued`, `uploading`,
/// `registering` and `done`, one stage per `stepDelay`. The first send to the Receipts lake fails while
/// uploading ("No connection."), so the failed state and its retry can be seen; retrying succeeds.
public actor FixtureCaptureJobs: CaptureSubmitting, CaptureJobTracking {
  private let submitDelay: Duration
  private let stepDelay: Duration
  private var stored: [UploadJob] = []
  private var alreadyFailed: Set<UUID> = []
  private var observers: [UUID: AsyncStream<[UploadJob]>.Continuation] = [:]

  public init(submitDelay: Duration = .milliseconds(600), stepDelay: Duration = .milliseconds(2_500)) {
    self.submitDelay = submitDelay
    self.stepDelay = stepDelay
  }

  public func submit(
    _ items: [ShareItem], to destination: CaptureDestination, note: String?
  ) async throws -> [UploadJob] {
    try? await Task.sleep(for: submitDelay)
    let created = items.map {
      UploadJob(destination: destination, payload: .message($0.displayName), note: note, now: Date())
    }
    stored += created
    notify()
    for job in created { Task { await run(job.id) } }
    return created
  }

  public func jobs() -> [UploadJob] { stored }

  public func updates() -> AsyncStream<[UploadJob]> {
    let (stream, continuation) = AsyncStream<[UploadJob]>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let id = UUID()
    observers[id] = continuation
    continuation.yield(stored)
    continuation.onTermination = { [weak self] _ in
      Task { await self?.removeObserver(id) }
    }
    return stream
  }

  public func retry(jobID: UUID) async {
    guard set(jobID, stage: .queued, error: nil, onlyIf: .failed) else { return }
    await run(jobID)
  }

  public func discard(jobID: UUID) {
    stored.removeAll { $0.id == jobID }
    notify()
  }

  private func run(_ id: UUID) async {
    for stage in [UploadStage.uploading, .registering, .done] {
      try? await Task.sleep(for: stepDelay)
      guard let job = stored.first(where: { $0.id == id }), job.stage != .failed else { return }
      if stage == .uploading, job.destination.id == Self.flakyDestinationID, alreadyFailed.insert(id).inserted {
        set(id, stage: .failed, error: "No connection.")
        return
      }
      set(id, stage: stage, error: nil)
    }
  }

  private static let flakyDestinationID = CaptureDestination.lake(id: "fixture-lake-receipts", name: "").id

  @discardableResult
  private func set(_ id: UUID, stage: UploadStage, error: String?, onlyIf required: UploadStage? = nil) -> Bool {
    guard let index = stored.firstIndex(where: { $0.id == id }) else { return false }
    if let required, stored[index].stage != required { return false }
    stored[index].stage = stage
    stored[index].lastError = error
    notify()
    return true
  }

  private func removeObserver(_ id: UUID) { observers[id] = nil }

  private func notify() {
    for continuation in observers.values { continuation.yield(stored) }
  }
}
