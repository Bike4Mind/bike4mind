import Foundation

/// Offline stand-ins for every capture service, so `B4M_UI_FIXTURES=1` exercises the share and capture UI
/// (in the app and in the share extension) with no server.
public enum CaptureFixtures {
  public static let lakes = [
    LakeSummary(id: "fixture-lake-research", name: "Research", fileCount: 42, isBuiltIn: false),
    LakeSummary(id: "fixture-lake-receipts", name: "Receipts", fileCount: 9, isBuiltIn: false),
  ]

  public static let destinationSource: any DestinationSource = FixtureDestinationSource()
  public static let submitter: any CaptureSubmitting = FixtureSubmitter()
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

  private struct FixtureSubmitter: CaptureSubmitting {
    func submit(_ items: [ShareItem], to destination: CaptureDestination, note: String?) async throws -> [UploadJob] {
      try? await Task.sleep(for: .milliseconds(600))
      return items.map { item in
        var job = UploadJob(
          destination: destination, payload: .message(item.displayName), note: note, now: Date())
        job.stage = .done
        return job
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
