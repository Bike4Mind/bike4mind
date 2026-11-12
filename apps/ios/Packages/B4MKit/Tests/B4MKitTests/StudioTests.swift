import CoreGraphics
import XCTest

@testable import B4MKit

// MARK: - Doubles

actor FakeStudioAPI: StudioAPI {
  private(set) var statusCalls: [String] = []
  private(set) var cancelled: [String] = []
  private(set) var edits: [ImageEditRequest] = []
  private(set) var generated: [GenerationRequest] = []
  private(set) var sessionsCreated: [String] = []
  private var statuses: [String: [Result<GenerationStatus, APIError>]] = [:]
  var models: [GenerationKind: [GenerationModel]] = [:]
  var generateFailure: (any Error)?

  func script(_ id: String, _ results: [Result<GenerationStatus, APIError>]) {
    statuses[id] = results
  }

  func setModels(_ kind: GenerationKind, _ list: [GenerationModel]) { models[kind] = list }
  func failGenerate(with error: any Error) { generateFailure = error }

  func models(for kind: GenerationKind) async throws -> [GenerationModel] { models[kind] ?? [] }

  func generate(_ request: GenerationRequest) async throws -> GenerationHandle {
    if let generateFailure { throw generateFailure }
    generated.append(request)
    return GenerationHandle(kind: request.kind, id: "gen-\(generated.count)", prompt: request.prompt, startedAt: Date())
  }

  func editImage(_ request: ImageEditRequest) async throws -> GenerationHandle {
    edits.append(request)
    return GenerationHandle(kind: .image, id: "edit-\(edits.count)", prompt: request.summaryPrompt, startedAt: Date())
  }

  func status(of handle: GenerationHandle) async throws -> GenerationStatus {
    statusCalls.append(handle.id)
    guard var queue = statuses[handle.id], !queue.isEmpty else {
      return GenerationStatus(phase: .running(progress: nil))
    }
    let next = queue.removeFirst()
    if !queue.isEmpty { statuses[handle.id] = queue }
    return try next.get()
  }

  func cancel(_ handle: GenerationHandle) async throws { cancelled.append(handle.id) }

  func createSession(name: String) async throws -> String {
    sessionsCreated.append(name)
    return "session-new"
  }
}

final class MemoryGenerationStore: GenerationStore, @unchecked Sendable {
  let saved = Locked<[GenerationHandle]>([])
  init(_ handles: [GenerationHandle] = []) { saved.mutate { $0 = handles } }
  func load() -> [GenerationHandle] { saved.current }
  func save(_ handles: [GenerationHandle]) { saved.mutate { $0 = handles } }
}

private func handle(_ id: String, _ kind: GenerationKind = .video, startedAt: Date = Date()) -> GenerationHandle {
  GenerationHandle(kind: kind, id: id, prompt: "a fox", startedAt: startedAt)
}

private let noSleep: GenerationTracker.Sleep = { _ in
  await Task.yield()
  try Task.checkCancellation()
}

// MARK: - Geometry

final class EditRegionTests: XCTestCase {
  func testFittedFrameLetterboxesAWideImage() {
    let frame = RegionGeometry.fittedFrame(
      imageSize: CGSize(width: 200, height: 100), in: CGSize(width: 100, height: 100))
    XCTAssertEqual(frame, CGRect(x: 0, y: 25, width: 100, height: 50))
  }

  func testNormalizedIsRelativeToTheImageNotTheView() {
    let imageFrame = CGRect(x: 0, y: 25, width: 100, height: 50)
    let rect = RegionGeometry.normalized(CGRect(x: 50, y: 25, width: 50, height: 25), imageFrame: imageFrame)
    XCTAssertEqual(rect, CGRect(x: 0.5, y: 0, width: 0.5, height: 0.5))
  }

  func testABoxDrawnBackwardsOrPastTheImageIsClipped() {
    let imageFrame = CGRect(x: 0, y: 0, width: 100, height: 100)
    let rect = RegionGeometry.normalized(CGRect(x: 120, y: 50, width: -40, height: -70), imageFrame: imageFrame)
    XCTAssertEqual(rect, CGRect(x: 0.8, y: 0, width: 0.2, height: 0.5))
  }

  func testATinyOrOffImageBoxIsRejected() {
    let imageFrame = CGRect(x: 0, y: 0, width: 100, height: 100)
    XCTAssertNil(RegionGeometry.normalized(CGRect(x: 10, y: 10, width: 1, height: 40), imageFrame: imageFrame))
    XCTAssertNil(RegionGeometry.normalized(CGRect(x: 200, y: 200, width: 40, height: 40), imageFrame: imageFrame))
  }

  func testViewRectRoundTrips() {
    let imageFrame = CGRect(x: 10, y: 20, width: 200, height: 100)
    let normalized = CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.25)
    let view = RegionGeometry.viewRect(normalized, imageFrame: imageFrame)
    XCTAssertEqual(RegionGeometry.normalized(view, imageFrame: imageFrame), normalized)
  }

  func testBBoxIsVerticalAxisFirst() {
    let region = EditRegion(rect: CGRect(x: 0.1, y: 0.2, width: 0.4, height: 0.4), prompt: "door")
    XCTAssertEqual(region.bbox.map { ($0 * 1000).rounded() / 1000 }, [0.2, 0.1, 0.6, 0.5])
  }
}

// MARK: - Wire

final class StudioWireTests: XCTestCase {
  func testJobStates() {
    XCTAssertEqual(StudioWire.phase(jobState: "pending", progress: nil, errorCode: nil, availability: nil), .queued)
    XCTAssertEqual(
      StudioWire.phase(jobState: "storing", progress: 0.9, errorCode: nil, availability: nil), .running(progress: 0.9))
    XCTAssertEqual(
      StudioWire.phase(jobState: "blocked", progress: nil, errorCode: nil, availability: nil), .failed(.blocked))
    XCTAssertEqual(
      StudioWire.phase(jobState: "cancelled", progress: nil, errorCode: nil, availability: nil), .cancelled)
    XCTAssertEqual(
      StudioWire.phase(jobState: "failed", progress: nil, errorCode: "content_blocked", availability: nil),
      .failed(.blocked))
  }

  func testASucceededJobIsOnlyDoneOnceItsOutputIsReady() {
    XCTAssertEqual(
      StudioWire.phase(jobState: "succeeded", progress: nil, errorCode: nil, availability: "pending_scan"),
      .running(progress: 1))
    XCTAssertEqual(
      StudioWire.phase(jobState: "succeeded", progress: nil, errorCode: nil, availability: "unavailable"),
      .failed(.other(code: "output_unavailable")))
    XCTAssertEqual(
      StudioWire.phase(jobState: "succeeded", progress: nil, errorCode: nil, availability: "ready"), .succeeded)
  }

  func testQuestPollMapping() throws {
    func poll(_ json: String) throws -> GenerationStatus {
      StudioWire.status(of: try JSONDecoder().decode(StudioWire.QuestPoll.self, from: Data(json.utf8)))
    }
    XCTAssertEqual(try poll(#"{"status":"pending","files":[]}"#).phase, .queued)
    XCTAssertEqual(try poll(#"{"status":"running","files":[]}"#).phase, .running(progress: nil))
    XCTAssertEqual(
      try poll(#"{"status":"done","type":"error","errorCode":"insufficient_credits","files":[]}"#).phase,
      .failed(.insufficientCredits))
    XCTAssertEqual(try poll(#"{"status":"stopped","type":"message","files":[]}"#).phase, .failed(.other(code: nil)))
    let done = try poll(
      #"{"status":"done","type":"message","files":[{"name":"a.png","url":"https://cdn.example.test/a.png","isImage":true},{"name":"t.txt","url":"https://cdn.example.test/t.txt","isImage":false}]}"#
    )
    XCTAssertEqual(done.phase, .succeeded)
    XCTAssertEqual(done.resultURLs, [URL(string: "https://cdn.example.test/a.png")!])
  }

  func testJobFrame() {
    let running = ActionFrame(
      action: "generation_job_updated",
      payload: [
        "job": .object([
          "id": .string("j1"), "kind": .string("video"), "state": .string("running"), "progress": .number(0.4),
        ])
      ])
    XCTAssertEqual(GenerationJobFrame(running)?.status.phase, .running(progress: 0.4))
    XCTAssertEqual(GenerationJobFrame(running)?.needsFetch, false)

    let done = ActionFrame(
      action: "generation_job_updated",
      payload: ["job": .object(["id": .string("j1"), "kind": .string("video"), "state": .string("succeeded")])])
    XCTAssertEqual(GenerationJobFrame(done)?.needsFetch, true)

    XCTAssertNil(GenerationJobFrame(ActionFrame(action: "streamed_chat_completion", payload: [:])))
    XCTAssertNil(GenerationJobFrame(ActionFrame(action: "generation_job_updated", payload: ["job": .object([:])])))
  }
}

final class StudioClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  private func body(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testImageGenerationPostsALiteralPromptAndReturnsTheQuest() async throws {
    let transport = FakeTransport { _ in
      (200, Data(#"{"quest":{"id":"q1","sessionId":"s1"},"session":{"id":"s1"}}"#.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let handle = try await client.generate(GenerationRequest(kind: .image, prompt: "a fox", modelID: "gpt-image-2"))

    XCTAssertEqual(handle.id, "q1")
    XCTAssertEqual(handle.kind, .image)
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/v1/image-generations")
    let sent = try body(request)
    XCTAssertEqual(sent["prompt"] as? String, "a fox")
    XCTAssertEqual(sent["model"] as? String, "gpt-image-2")
    XCTAssertEqual(sent["prompt_resolution"] as? String, "literal")
    XCTAssertTrue(sent["organization_id"] is NSNull, "an omitted key bills the home org, not personal credits")
  }

  func testMusicSendsOnlyDeclaredKeys() async throws {
    let transport = FakeTransport { _ in (202, Data(#"{"id":"m1","state":"pending"}"#.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    _ = try await client.generate(GenerationRequest(kind: .music, prompt: "lofi", modelID: "m", instrumental: true))
    _ = try await client.generate(GenerationRequest(kind: .video, prompt: "waves", modelID: "v", instrumental: true))

    let requests = await transport.requests
    XCTAssertEqual(requests.map { $0.url?.path() }, ["/api/v1/music-generations", "/api/v1/video-generations"])
    XCTAssertEqual(Set(try body(requests[0]).keys), ["model", "prompt", "instrumental", "organization_id"])
    XCTAssertEqual(Set(try body(requests[1]).keys), ["model", "prompt", "organization_id"])
    XCTAssertTrue(try body(requests[0])["organization_id"] is NSNull)
  }

  func testRefusalCarriesTheServerErrorCode() async {
    let transport = FakeTransport { _ in
      (422, Data(#"{"error":"Not enough credits","errorCode":"insufficient_credits"}"#.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.generate(GenerationRequest(kind: .video, prompt: "x", modelID: "v"))
      XCTFail("expected a refusal")
    } catch {
      XCTAssertEqual((error as? StudioRequestError)?.failure, .insufficientCredits)
    }
  }

  func testImageEditSendsRegionsVerticalAxisFirst() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"id":"q9","sessionId":"s1"}"#.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let regions = [
      EditRegion(rect: CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.25), prompt: "a red door"),
      EditRegion(rect: CGRect(x: 0, y: 0, width: 0.5, height: 0.5), prompt: "  blue sky "),
    ]

    let handle = try await client.editImage(
      ImageEditRequest(
        imageURL: URL(string: "https://cdn.example.test/src.png?sig=1")!, sessionID: "s1", modelID: "flux-3-image",
        regions: regions))

    XCTAssertEqual(handle.id, "q9")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/v1/image-edits")
    let sent = try body(request)
    XCTAssertEqual(sent["sessionId"] as? String, "s1")
    XCTAssertEqual(sent["image"] as? String, "https://cdn.example.test/src.png?sig=1")
    XCTAssertEqual(sent["prompt"] as? String, "a red door; blue sky")
    let sentRegions = try XCTUnwrap(sent["edit_regions"] as? [[String: Any]])
    XCTAssertEqual(sentRegions.first?["bbox"] as? [Double], [0.5, 0.25, 0.75, 0.75])
    XCTAssertNil(sent["fabFileIds"], "FLUX 3 rejects a mask")
    XCTAssertTrue(sent["organization_id"] is NSNull)
  }

  func testStatusRoutesByKind() async throws {
    let transport = FakeTransport { request in
      if request.url?.path() == "/api/v1/quests/q1" {
        return (200, Data(#"{"status":"running","files":[]}"#.utf8))
      }
      return (
        200,
        Data(
          #"{"id":"v1","state":"succeeded","output":{"availability":"ready","url":"https://cdn.example.test/v.mp4"}}"#
            .utf8)
      )
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let image = try await client.status(of: handle("q1", .image))
    let video = try await client.status(of: handle("v1", .video))

    XCTAssertEqual(image.phase, .running(progress: nil))
    XCTAssertEqual(video.phase, .succeeded)
    XCTAssertEqual(video.resultURLs, [URL(string: "https://cdn.example.test/v.mp4")!])
    let paths = await transport.requests.map { $0.url?.path() }
    XCTAssertEqual(paths, ["/api/v1/quests/q1", "/api/v1/video-generations/v1"])
  }

  func testAnUnsafeIDNeverReachesTheNetwork() async {
    let transport = FakeTransport()
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.status(of: handle("../files", .video))
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? APIError, .notFound)
    }
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }

  func testImageModelsFollowTheCursorAndKeepCurrentImageModels() async throws {
    let transport = FakeTransport { request in
      let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
        .first { $0.name == "cursor" }?.value
      if cursor == nil {
        return (
          200,
          Data(
            #"{"data":[{"id":"gpt-image-2","name":"GPT Image 2","type":"image"},{"id":"claude","type":"text"}],"next_cursor":"c2"}"#
              .utf8)
        )
      }
      return (
        200,
        Data(
          #"{"data":[{"id":"old","type":"image","deprecation_date":"2026-01-01"},{"id":"flux-3-image","name":"FLUX 3","type":"image"}],"next_cursor":null}"#
            .utf8)
      )
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let models = try await client.models(for: .image)

    XCTAssertEqual(models.map(\.id), ["gpt-image-2", "flux-3-image"])
  }

  func testVideoModelsNeedTextToVideo() async throws {
    let transport = FakeTransport { _ in
      (
        200,
        Data(
          #"{"models":[{"id":"a","display_name":"A","modes":["text_to_video"]},{"id":"b","modes":["image_to_video"]}]}"#
            .utf8)
      )
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let models = try await client.models(for: .video)
    XCTAssertEqual(models.map(\.id), ["a"])
  }

  func testCreateSessionReadsTheID() async throws {
    let transport = FakeTransport { _ in (200, Data(#"{"id":"s7","name":"Studio edits"}"#.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let id = try await client.createSession(name: "Studio edits")
    XCTAssertEqual(id, "s7")
  }
}

// MARK: - Tracker

@MainActor
final class GenerationTrackerTests: XCTestCase {
  func testPollsUntilSucceededAndReportsTheResult() async {
    let api = FakeStudioAPI()
    let url = URL(string: "https://cdn.example.test/out.png")!
    await api.script(
      "q1",
      [
        .success(GenerationStatus(phase: .running(progress: nil))),
        .success(GenerationStatus(phase: .succeeded, resultURLs: [url])),
      ])
    let store = MemoryGenerationStore()
    let succeeded = Locked<[String]>([])
    let tracker = GenerationTracker(
      api: api, realtime: nil, store: store, sleep: noSleep,
      onSucceeded: { tracked in succeeded.mutate { $0.append(tracked.id) } })

    tracker.track(handle("q1", .image))
    XCTAssertEqual(store.load().map(\.id), ["q1"])

    await eventually { await MainActor.run { tracker.generations.first?.phase == .succeeded } }
    XCTAssertEqual(tracker.generations.first?.resultURLs, [url])
    XCTAssertTrue(store.load().isEmpty, "a settled generation is not resumed")
    await eventually { succeeded.current == ["q1"] }
    XCTAssertEqual(tracker.succeededCount, 1)
  }

  func testAFrameUpdatesItsJobAndASuccessFrameTriggersAFetch() async {
    let api = FakeStudioAPI()
    let realtime = FakeRealtime()
    let tracker = GenerationTracker(
      api: api, realtime: realtime, store: MemoryGenerationStore(),
      sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    tracker.resume()
    tracker.track(handle("v1"))
    await eventually { await realtime.listenerCount == 1 }

    await realtime.emit(
      .frame(
        ActionFrame(
          action: "generation_job_updated",
          payload: [
            "job": .object([
              "id": .string("v1"), "kind": .string("video"), "state": .string("running"), "progress": .number(0.5),
            ])
          ])))
    await eventually { await MainActor.run { tracker.generations.first?.phase == .running(progress: 0.5) } }

    await api.script("v1", [.success(GenerationStatus(phase: .succeeded))])
    await realtime.emit(
      .frame(
        ActionFrame(
          action: "generation_job_updated",
          payload: ["job": .object(["id": .string("v1"), "kind": .string("video"), "state": .string("succeeded")])])))
    await eventually { await MainActor.run { tracker.generations.first?.phase == .succeeded } }
    let calls = await api.statusCalls
    XCTAssertEqual(calls, ["v1"])
  }

  func testFramesForOtherJobsAreIgnored() async {
    let api = FakeStudioAPI()
    let realtime = FakeRealtime()
    let tracker = GenerationTracker(
      api: api, realtime: realtime, store: MemoryGenerationStore(),
      sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    tracker.resume()
    tracker.track(handle("v1"))
    await eventually { await realtime.listenerCount == 1 }

    await realtime.emit(
      .frame(
        ActionFrame(
          action: "generation_job_updated",
          payload: ["job": .object(["id": .string("other"), "kind": .string("video"), "state": .string("succeeded")])]))
    )
    try? await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(tracker.generations.map(\.phase), [.queued])
    let calls = await api.statusCalls
    XCTAssertTrue(calls.isEmpty)
  }

  func testReconnectPollsEverythingStillRunning() async {
    let api = FakeStudioAPI()
    let realtime = FakeRealtime()
    await api.script("v1", [.success(GenerationStatus(phase: .failed(.blocked)))])
    let tracker = GenerationTracker(
      api: api, realtime: realtime, store: MemoryGenerationStore(),
      sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    tracker.resume()
    tracker.track(handle("v1"))
    await eventually { await realtime.listenerCount == 1 }

    await realtime.emit(.refetchNeeded)

    await eventually { await MainActor.run { tracker.generations.first?.phase == .failed(.blocked) } }
  }

  func testResumeTracksRecentStoredGenerationsAndDropsOldOnes() async {
    let now = Date()
    let store = MemoryGenerationStore([
      handle("recent", startedAt: now.addingTimeInterval(-60)),
      handle("stale", startedAt: now.addingTimeInterval(-GenerationTracker.resumeWindow - 1)),
    ])
    let tracker = GenerationTracker(
      api: FakeStudioAPI(), realtime: nil, store: store, sleep: { _ in try await Task.sleep(for: .seconds(3600)) },
      now: { now })

    tracker.resume()

    XCTAssertEqual(tracker.generations.map(\.id), ["recent"])
    XCTAssertEqual(store.load().map(\.id), ["recent"])
  }

  func testPollingStopsAfterThePollWindow() async {
    let api = FakeStudioAPI()
    let startedAt = Date().addingTimeInterval(-GenerationTracker.pollWindow - 1)
    let tracker = GenerationTracker(api: api, realtime: nil, store: MemoryGenerationStore(), sleep: noSleep)

    tracker.track(handle("old", startedAt: startedAt))
    try? await Task.sleep(for: .milliseconds(50))

    let calls = await api.statusCalls
    XCTAssertTrue(calls.isEmpty)
    XCTAssertEqual(tracker.generations.first?.phase, .queued)
  }

  func testCancelOnlyAppliesToRunningJobs() async throws {
    let api = FakeStudioAPI()
    let tracker = GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )
    tracker.track(handle("img", .image))
    tracker.track(handle("v1"))

    try await tracker.cancel("img")
    try await tracker.cancel("v1")

    let cancelled = await api.cancelled
    XCTAssertEqual(cancelled, ["v1"])
    XCTAssertEqual(tracker.generations.first { $0.id == "v1" }?.phase, .cancelled)
    tracker.dismiss("v1")
    tracker.dismiss("img")
    XCTAssertEqual(tracker.generations.map(\.id), ["img"], "a running generation cannot be dismissed")
  }

  func testAMissingGenerationIsForgotten() async {
    let api = FakeStudioAPI()
    await api.script("gone", [.failure(.notFound)])
    let store = MemoryGenerationStore()
    let tracker = GenerationTracker(api: api, realtime: nil, store: store, sleep: noSleep)
    tracker.track(handle("gone"))
    await eventually { await MainActor.run { tracker.generations.isEmpty } }
    XCTAssertTrue(store.load().isEmpty)
  }

  func testResetForgetsEverything() {
    let store = MemoryGenerationStore()
    let tracker = GenerationTracker(
      api: FakeStudioAPI(), realtime: nil, store: store, sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    tracker.track(handle("v1"))
    tracker.reset()
    XCTAssertTrue(tracker.generations.isEmpty)
    XCTAssertTrue(store.load().isEmpty)
  }
}

// MARK: - Gallery provenance

final class MediaProvenanceTests: XCTestCase {
  func testGeneratedFileCarriesItsSessionAndPrompt() throws {
    let body = Data(
      #"{"id":"f1","mimeType":"image/png","fileName":"a.png","sourceMetadata":{"sessionId":"s1","generation":{"prompt":"a fox","generator":"image"}}}"#
        .utf8)
    let item = try MediaWire.item(status: 200, body: body)
    XCTAssertEqual(item.sessionID, "s1")
    XCTAssertEqual(item.prompt, "a fox")
  }

  func testUnexpectedProvenanceNeverDropsTheFile() throws {
    let body = Data(
      #"{"id":"f1","mimeType":"image/png","sourceMetadata":{"sessionId":42,"generation":"weird"}}"#.utf8)
    let item = try MediaWire.item(status: 200, body: body)
    XCTAssertNil(item.sessionID)
    XCTAssertNil(item.prompt)
  }

  func testAnEmptyPromptReadsAsUnknown() throws {
    let body = Data(#"{"id":"f1","mimeType":"image/png","sourceMetadata":{"generation":{"prompt":""}}}"#.utf8)
    XCTAssertNil(try MediaWire.item(status: 200, body: body).prompt)
  }
}

// MARK: - View models

@MainActor
final class StudioCreateViewModelTests: XCTestCase {
  private func makeTracker(_ api: FakeStudioAPI) -> GenerationTracker {
    GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )
  }

  func testSubmitStartsTrackingAndClearsThePrompt() async {
    let api = FakeStudioAPI()
    await api.setModels(.music, [GenerationModel(id: "m1", name: "M1"), GenerationModel(id: "m2", name: "M2")])
    let tracker = makeTracker(api)
    let model = StudioCreateViewModel(api: api, tracker: tracker)
    model.kind = .music
    await model.loadModels()
    model.select(model: GenerationModel(id: "m2", name: "M2"))
    model.instrumental = true
    model.prompt = "  rainy lofi  "

    let started = await model.submit()

    XCTAssertTrue(started)
    XCTAssertEqual(model.prompt, "")
    let generated = await api.generated
    XCTAssertEqual(
      generated, [GenerationRequest(kind: .music, prompt: "rainy lofi", modelID: "m2", instrumental: true)])
    XCTAssertEqual(tracker.generations.map(\.handle.kind), [.music])
  }

  func testABlankPromptOrNoModelCannotSubmit() async {
    let api = FakeStudioAPI()
    let model = StudioCreateViewModel(api: api, tracker: makeTracker(api))
    model.kind = .video
    await model.loadModels()
    model.prompt = "waves"
    XCTAssertFalse(model.canSubmit, "video has no fallback model")

    model.kind = .image
    await model.loadModels()
    XCTAssertEqual(model.selectedModel?.id, "gpt-image-2")
    model.prompt = "   "
    XCTAssertFalse(model.canSubmit)
  }

  func testARefusalKeepsThePromptAndExplainsWhy() async {
    let api = FakeStudioAPI()
    await api.failGenerate(with: StudioRequestError(status: 422, code: "insufficient_credits", serverMessage: nil))
    let model = StudioCreateViewModel(api: api, tracker: makeTracker(api))
    await model.loadModels()
    model.prompt = "a fox"

    let started = await model.submit()

    XCTAssertFalse(started)
    XCTAssertEqual(model.prompt, "a fox")
    XCTAssertEqual(model.error, .refused(.insufficientCredits))
  }
}

@MainActor
final class RegionEditViewModelTests: XCTestCase {
  private let image = MediaItem(
    id: "f1", kind: .image, fileName: "a.png", mimeType: "image/png", createdAt: Date(),
    url: URL(string: "https://cdn.example.test/old.png"))

  private func makeTracker(_ api: FakeStudioAPI) -> GenerationTracker {
    GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )
  }

  func testRegionsAreCappedAndEachNeedsAPrompt() {
    let api = FakeStudioAPI()
    let model = RegionEditViewModel(item: image, api: api, media: FakeMediaAPI(), tracker: makeTracker(api))
    for _ in 0..<RegionGeometry.maximumRegions { model.addRegion(CGRect(x: 0, y: 0, width: 0.5, height: 0.5)) }
    XCTAssertNil(model.addRegion(CGRect(x: 0, y: 0, width: 0.5, height: 0.5)))
    XCTAssertFalse(model.canSubmit)

    for region in model.regions { model.setPrompt("x", for: region.id) }
    XCTAssertTrue(model.canSubmit)

    let last = model.regions.last!.id
    model.removeRegion(last)
    XCTAssertEqual(model.regions.count, RegionGeometry.maximumRegions - 1)
    XCTAssertEqual(model.selectedRegionID, model.regions.last?.id)
  }

  func testSubmitUsesAFreshURLAndTheImagesOwnSession() async {
    let api = FakeStudioAPI()
    let media = FakeMediaAPI()
    let fresh = URL(string: "https://cdn.example.test/fresh.png")!
    await media.setDetail([
      MediaItem(
        id: "f1", kind: .image, fileName: "a.png", mimeType: "image/png", createdAt: Date(), url: fresh,
        sessionID: "s1")
    ])
    let tracker = makeTracker(api)
    let model = RegionEditViewModel(item: image, api: api, media: media, tracker: tracker)
    let region = model.addRegion(CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.3))!
    model.setPrompt("a hat", for: region.id)

    let started = await model.submit()

    XCTAssertTrue(started)
    let edits = await api.edits
    XCTAssertEqual(edits.first?.imageURL, fresh)
    XCTAssertEqual(edits.first?.sessionID, "s1")
    XCTAssertEqual(edits.first?.modelID, "flux-3-image")
    let created = await api.sessionsCreated
    XCTAssertTrue(created.isEmpty)
    XCTAssertEqual(tracker.generations.map(\.id), ["edit-1"])
  }

  func testAnImageWithNoSessionGetsANewOne() async {
    let api = FakeStudioAPI()
    let media = FakeMediaAPI()
    await media.setDetail([image])
    let model = RegionEditViewModel(item: image, api: api, media: media, tracker: makeTracker(api))
    let region = model.addRegion(CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.3))!
    model.setPrompt("a hat", for: region.id)

    await model.submit()

    let created = await api.sessionsCreated
    XCTAssertEqual(created, ["Studio edits"])
    let edits = await api.edits
    XCTAssertEqual(edits.first?.sessionID, "session-new")
  }
}
