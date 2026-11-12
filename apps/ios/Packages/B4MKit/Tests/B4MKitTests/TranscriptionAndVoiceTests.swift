import XCTest

@testable import B4MKit

final class TranscriptionClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!
  private let temp = TempDirectory()

  private func client(_ transport: FakeTransport) -> TranscriptionClient {
    TranscriptionClient(baseURL: base, tokens: FakeTokens(), transport: transport)
  }

  private static let uploadReply = Data(
    #"{"upload_url":"https://bucket.s3.amazonaws.com/","upload_fields":{"key":"transcribe-uploads/u/1.m4a","Content-Type":"audio/mp4","Policy":"p"},"file_key":"transcribe-uploads/u/1.m4a","expires_at":"2026-11-02T12:05:00.000Z"}"#
      .utf8)

  private func happyTransport() -> FakeTransport {
    FakeTransport { request in
      switch request.url?.host() {
      case "bucket.s3.amazonaws.com": return (204, Data())
      default:
        switch request.url?.path() {
        case "/api/v1/transcriptions/uploads": return (201, Self.uploadReply)
        case "/api/v1/transcriptions": return (200, Data(#"{"text":"  hello world \n"}"#.utf8))
        default: return (404, Data())
        }
      }
    }
  }

  func testTheThreeStepFlowReturnsTheTrimmedText() async throws {
    let transport = happyTransport()
    let audio = temp.file("note.m4a", contents: Data(repeating: 7, count: 100))
    let text = try await client(transport).transcribe(audioFile: audio, mimeType: "audio/mp4")
    XCTAssertEqual(text, "hello world")

    let requests = await transport.requests
    XCTAssertEqual(
      requests.map { $0.url?.host() ?? "" }, ["app.example.test", "bucket.s3.amazonaws.com", "app.example.test"])
    let mint = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[0].httpBody)) as? [String: Any])
    XCTAssertEqual(mint["mime_type"] as? String, "audio/mp4")
    XCTAssertEqual(mint["file_size"] as? Int, 100)
    let finish = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[2].httpBody)) as? [String: Any])
    XCTAssertEqual(finish["file_key"] as? String, "transcribe-uploads/u/1.m4a")
  }

  func testTheStorageUploadIsMultipartWithFieldsFirstAndNoBearer() async throws {
    let transport = happyTransport()
    let audio = temp.file("note.m4a", contents: Data("AUDIO".utf8))
    _ = try await client(transport).transcribe(audioFile: audio, mimeType: "audio/mp4")

    let requests = await transport.requests
    let upload = requests[1]
    XCTAssertEqual(upload.httpMethod, "POST")
    XCTAssertNil(upload.value(forHTTPHeaderField: "Authorization"))
    let contentType = try XCTUnwrap(upload.value(forHTTPHeaderField: "Content-Type"))
    XCTAssertTrue(contentType.hasPrefix("multipart/form-data; boundary="))
    let body = String(decoding: try XCTUnwrap(upload.httpBody), as: UTF8.self)
    let fileRange = try XCTUnwrap(body.range(of: #"name="file""#))
    for field in ["key", "Content-Type", "Policy"] {
      let range = try XCTUnwrap(body.range(of: #"name="\#(field)""#), "missing \(field)")
      XCTAssertLessThan(range.lowerBound, fileRange.lowerBound, "\(field) must precede the file")
    }
    XCTAssertTrue(
      body.hasSuffix("AUDIO\r\n--" + String(contentType.dropFirst("multipart/form-data; boundary=".count)) + "--\r\n"))
  }

  func testAnEmptyRecordingNeverReachesTheNetwork() async {
    let transport = happyTransport()
    let audio = temp.file("empty.m4a", contents: Data())
    do {
      _ = try await client(transport).transcribe(audioFile: audio, mimeType: "audio/mp4")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? TranscriptionError, .unusableRecording)
    }
    let count = await transport.requests.count
    XCTAssertEqual(count, 0)
  }

  func testServerStatusesMapToTranscriptionErrors() async throws {
    let audio = temp.file("a.m4a")
    let cases: [(Int, String, TranscriptionError?)] = [
      (503, #"{"errorCode":"provider_not_configured"}"#, .unavailable),
      (422, #"{"errorCode":"insufficient_credits"}"#, .insufficientCredits),
      (422, #"{"error":"bad audio"}"#, .unusableRecording),
      (504, #"{"error":"timed out"}"#, .failed(message: "timed out")),
    ]
    for (status, body, expected) in cases {
      // The same refusal can come from minting the upload or from the final transcribe call.
      let failingMint = FakeTransport { _ in (status, Data(body.utf8)) }
      let failing = FakeTransport { request in
        if request.url?.host() == "bucket.s3.amazonaws.com" { return (204, Data()) }
        if request.url?.path() == "/api/v1/transcriptions/uploads" { return (201, Self.uploadReply) }
        return (status, Data(body.utf8))
      }
      for candidate in [failingMint, failing] {
        do {
          _ = try await client(candidate).transcribe(audioFile: audio, mimeType: "audio/mp4")
          XCTFail("expected failure for \(status)")
        } catch {
          XCTAssertEqual(error as? TranscriptionError, expected)
        }
      }
    }
  }

  func testAFailedStorageUploadIsReported() async {
    let transport = FakeTransport { request in
      request.url?.host() == "bucket.s3.amazonaws.com" ? (403, Data()) : (201, Self.uploadReply)
    }
    do {
      _ = try await client(transport).transcribe(audioFile: temp.file("a.m4a"), mimeType: "audio/mp4")
      XCTFail("expected failure")
    } catch {
      XCTAssertEqual(error as? TranscriptionError, .failed(message: "The recording did not upload."))
    }
  }
}

// MARK: - Voice capture

actor FakeRecorder: AudioRecording {
  var currentPermission = MicrophonePermission.granted
  var grantsOnRequest = true
  var startError: (any Error)?
  var duration: TimeInterval = 3
  private(set) var started = 0
  private(set) var cancelled = 0
  private(set) var recordedFile: URL?
  let directory: TempDirectory

  init(directory: TempDirectory) { self.directory = directory }

  func configure(
    permission: MicrophonePermission? = nil, grants: Bool? = nil, startError: (any Error)?? = nil,
    duration: TimeInterval? = nil
  ) {
    if let permission { currentPermission = permission }
    if let grants { grantsOnRequest = grants }
    if let startError { self.startError = startError }
    if let duration { self.duration = duration }
  }

  func permission() async -> MicrophonePermission { currentPermission }

  func requestPermission() async -> Bool {
    currentPermission = grantsOnRequest ? .granted : .denied
    return grantsOnRequest
  }

  private var holdsStart = false
  private var startWaiter: CheckedContinuation<Void, Never>?
  var isWaitingToStart: Bool { startWaiter != nil }

  /// Makes the next `start()` suspend until `releaseStart()`, like a slow audio session setup.
  func holdStart() { holdsStart = true }

  func releaseStart() {
    holdsStart = false
    startWaiter?.resume()
    startWaiter = nil
  }

  func start() async throws {
    if holdsStart { await withCheckedContinuation { startWaiter = $0 } }
    if let startError { throw startError }
    started += 1
  }

  func stop() async throws -> VoiceRecording {
    let url = directory.file("voice-\(started).m4a", contents: Data("audio".utf8))
    recordedFile = url
    return VoiceRecording(fileURL: url, duration: duration)
  }

  func cancel() async { cancelled += 1 }
}

actor FakeTranscriber: TranscriptionService {
  var result: Result<String, any Error> = .success("a thought")
  private(set) var files: [URL] = []

  func set(_ result: Result<String, any Error>) { self.result = result }

  func transcribe(audioFile: URL, mimeType: String) async throws -> String {
    files.append(audioFile)
    return try result.get()
  }
}

@MainActor
final class VoiceCaptureModelTests: XCTestCase {
  private let temp = TempDirectory()

  private func make() -> (VoiceCaptureModel, FakeRecorder, FakeTranscriber) {
    let recorder = FakeRecorder(directory: temp)
    let transcriber = FakeTranscriber()
    return (VoiceCaptureModel(recorder: recorder, transcriber: transcriber), recorder, transcriber)
  }

  func testRecordStopTranscribeHandsBackTheText() async {
    let (model, _, _) = make()
    XCTAssertEqual(model.state, .idle)
    await model.start()
    XCTAssertEqual(model.state, .recording)
    XCTAssertTrue(model.isBusy)
    await model.stop()
    XCTAssertEqual(model.state, .transcribed("a thought"))
    XCTAssertEqual(model.consumeTranscript(), "a thought")
    XCTAssertEqual(model.state, .idle)
    XCTAssertNil(model.consumeTranscript())
  }

  func testTheRecordingIsDeletedAfterTranscription() async throws {
    let (model, recorder, _) = make()
    await model.start()
    await model.stop()
    let recorded = await recorder.recordedFile
    let file = try XCTUnwrap(recorded)
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
  }

  func testADeniedMicrophoneFailsWithoutRecording() async {
    let (model, recorder, _) = make()
    await recorder.configure(permission: .denied)
    await model.start()
    XCTAssertEqual(model.state, .failed(.microphoneDenied))
    let started = await recorder.started
    XCTAssertEqual(started, 0)
  }

  func testAnUndeterminedMicrophoneAsksOnceAndProceedsWhenGranted() async {
    let (model, recorder, _) = make()
    await recorder.configure(permission: .undetermined, grants: true)
    await model.start()
    XCTAssertEqual(model.state, .recording)
  }

  func testRefusingThePermissionPromptFails() async {
    let (model, recorder, _) = make()
    await recorder.configure(permission: .undetermined, grants: false)
    await model.start()
    XCTAssertEqual(model.state, .failed(.microphoneDenied))
  }

  func testARecorderThatCannotStartFails() async {
    let (model, recorder, _) = make()
    await recorder.configure(startError: .some(VoiceCaptureError.recordingFailed))
    await model.start()
    XCTAssertEqual(model.state, .failed(.recordingFailed))
  }

  func testAVeryShortClipIsNotTranscribed() async {
    let (model, recorder, transcriber) = make()
    await recorder.configure(duration: 0.1)
    await model.start()
    await model.stop()
    XCTAssertEqual(model.state, .failed(.tooShort))
    let files = await transcriber.files
    XCTAssertTrue(files.isEmpty)
  }

  func testTranscriptionErrorsAreMapped() async {
    let cases: [(any Error, VoiceCaptureError)] = [
      (TranscriptionError.insufficientCredits, .transcription(.insufficientCredits)),
      (TranscriptionError.unavailable, .transcription(.unavailable)),
      (APIError.offline, .offline),
      (APIError.signedOut, .signedOut),
      (APIError.server(status: 500), .other),
      (URLError(.badURL), .other),
    ]
    for (error, expected) in cases {
      let (model, _, transcriber) = make()
      await transcriber.set(.failure(error))
      await model.start()
      await model.stop()
      XCTAssertEqual(model.state, .failed(expected), "for \(error)")
    }
  }

  func testAnEmptyTranscriptIsAFailure() async {
    let (model, _, transcriber) = make()
    await transcriber.set(.success(""))
    await model.start()
    await model.stop()
    XCTAssertEqual(model.state, .failed(.transcription(.unusableRecording)))
  }

  func testCancelStopsAndReturnsToIdle() async {
    let (model, recorder, _) = make()
    await model.start()
    await model.cancel()
    XCTAssertEqual(model.state, .idle)
    let cancelled = await recorder.cancelled
    XCTAssertEqual(cancelled, 1)
  }

  func testASecondStartAndACancelWhileStartingLeaveNoRecorderRunning() async {
    let (model, recorder, _) = make()
    await recorder.holdStart()
    let first = Task { await model.start() }
    while !(await recorder.isWaitingToStart) { await Task.yield() }
    XCTAssertEqual(model.state, .starting)
    XCTAssertTrue(model.isBusy)

    await model.start()
    await model.cancel()
    await recorder.releaseStart()
    await first.value

    XCTAssertEqual(model.state, .idle, "a cancelled start never reaches recording")
    let started = await recorder.started
    let cancelled = await recorder.cancelled
    XCTAssertEqual(started, 1, "the second Start built no second recorder")
    XCTAssertEqual(cancelled, 2, "the recorder that came up after Cancel was torn down")
  }

  func testStartWhileBusyAndStopWhileIdleAreNoOps() async {
    let (model, recorder, _) = make()
    await model.stop()
    XCTAssertEqual(model.state, .idle)
    await model.start()
    await model.start()
    let started = await recorder.started
    XCTAssertEqual(started, 1)
  }

  func testResetClearsAFailureButNotARecording() async {
    let (model, recorder, _) = make()
    await recorder.configure(permission: .denied)
    await model.start()
    model.reset()
    XCTAssertEqual(model.state, .idle)
    await recorder.configure(permission: .granted)
    await model.start()
    model.reset()
    XCTAssertEqual(model.state, .recording)
  }

  func testEveryFailureHasUserFacingCopy() {
    let all: [VoiceCaptureError] = [
      .microphoneDenied, .recordingFailed, .tooShort, .offline, .signedOut, .other,
      .transcription(.unavailable), .transcription(.insufficientCredits), .transcription(.unusableRecording),
      .transcription(.failed(message: "x")),
    ]
    for error in all { XCTAssertFalse(error.message.isEmpty) }
  }
}
