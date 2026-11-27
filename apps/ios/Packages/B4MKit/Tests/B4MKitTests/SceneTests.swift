import XCTest

@testable import B4MKit

private let clip = MediaItem(id: "v1", kind: .video, fileName: "waves.mp4", mimeType: "video/mp4", createdAt: Date())
private let song = MediaItem(id: "a1", kind: .audio, fileName: "lofi.mp3", mimeType: "audio/mpeg", createdAt: Date())
private let art = MediaItem(id: "i1", kind: .image, fileName: "cover.png", mimeType: "image/png", createdAt: Date())

/// The `createSceneComposition` / `getSceneComposition` example from the OpenAPI spec
/// (b4m-core/common/src/api-contract/contracts/sceneComposition.contract.ts).
private let openAPIExampleJob = """
  {"id":"664f1c2b9a1e4d0012ab34cd","object":"scene_composition","state":"pending",
   "video_file_id":"664f1c2b9a1e4d0012ab34bb","audio_file_id":"664f1c2b9a1e4d0012ab34ee",
   "cover_file_id":null,"title":null,"audio":{"fit":"trim","fade_in_seconds":0,"fade_out_seconds":1.5},
   "source":"api","error":null,"output":null,"credits":{"reserved":null,"settled":null},
   "created_at":"2026-11-17T00:00:00.000Z","updated_at":"2026-11-17T00:00:00.000Z"}
  """

/// The same job once it rendered, per `SceneCompositionSchema`.
private let succeededJob = """
  {"id":"664f1c2b9a1e4d0012ab34cd","object":"scene_composition","state":"succeeded",
   "video_file_id":"664f1c2b9a1e4d0012ab34bb","audio_file_id":"664f1c2b9a1e4d0012ab34ee",
   "cover_file_id":null,"title":"Beach","audio":{"fit":"loop","fade_in_seconds":0,"fade_out_seconds":1.5},
   "source":"api","error":null,
   "output":{"availability":"ready","url":"https://cdn.example.test/scene.mp4","expires_at":"2026-11-17T01:00:00.000Z",
     "content_type":"video/mp4","duration_seconds":8,"file_id":"664f1c2b9a1e4d0012ab34ff"},
   "credits":{"reserved":null,"settled":0},
   "created_at":"2026-11-17T00:00:00.000Z","updated_at":"2026-11-17T00:01:00.000Z"}
  """

final class SceneDraftTests: XCTestCase {
  func testADraftStartsFromTheItemAndAsksForItsPartner() {
    XCTAssertEqual(SceneDraft.starting(from: clip)?.partnerKind, .audio)
    XCTAssertEqual(SceneDraft.starting(from: song)?.partnerKind, .video)
    XCTAssertNil(SceneDraft.starting(from: art))
  }

  func testAnUntouchedDraftSendsTheServerDefaults() throws {
    let request = try XCTUnwrap(SceneDraft(video: clip, audio: song).request)
    XCTAssertEqual(request.videoFileID, "v1")
    XCTAssertEqual(request.audioFileID, "a1")
    XCTAssertEqual(request.fit, .trim)
    XCTAssertNil(request.fadeInSeconds)
    XCTAssertNil(request.fadeOutSeconds)
    XCTAssertNil(request.coverFileID)
    XCTAssertNil(request.title)
    XCTAssertEqual(request.label, "waves + lofi")
  }

  func testFadesOffSendsNoFadeAndLoopIsKept() throws {
    let request = try XCTUnwrap(SceneDraft(video: clip, audio: song, fit: .loop, fades: false).request)
    XCTAssertEqual(request.fit, .loop)
    XCTAssertEqual(request.fadeInSeconds, 0)
    XCTAssertEqual(request.fadeOutSeconds, 0)
  }

  func testTitleIsTrimmedAndABlankOneIsLeftOut() throws {
    let titled = try XCTUnwrap(SceneDraft(video: clip, audio: song, title: "  Beach day ").request)
    XCTAssertEqual(titled.title, "Beach day")
    XCTAssertEqual(titled.label, "Beach day")
    XCTAssertNil(try XCTUnwrap(SceneDraft(video: clip, audio: song, title: "   ").request).title)
  }

  func testAMissingPartOrALongTitleBlocksTheRequest() {
    XCTAssertNotNil(SceneDraft(video: clip).issue)
    XCTAssertNil(SceneDraft(video: clip).request)
    XCTAssertNotNil(SceneDraft(audio: song).issue)
    let long = SceneDraft(video: clip, audio: song, title: String(repeating: "a", count: 201))
    XCTAssertNotNil(long.issue)
    XCTAssertNil(long.request)
  }

  func testEachSlotOnlyTakesItsOwnKind() throws {
    XCTAssertNil(SceneDraft(video: song, audio: clip).request)
    let request = try XCTUnwrap(SceneDraft(video: clip, audio: song, cover: clip).request)
    XCTAssertNil(request.coverFileID, "only an image can be the cover")
    XCTAssertEqual(try XCTUnwrap(SceneDraft(video: clip, audio: song, cover: art).request).coverFileID, "i1")
  }
}

final class SceneWireTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  private func body(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  func testComposePostsOnlyDeclaredKeysAndReadsTheOpenAPIExample() async throws {
    let transport = FakeTransport { _ in (202, Data(openAPIExampleJob.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let handle = try await client.composeScene(
      SceneRequest(videoFileID: "v1", audioFileID: "a1", coverFileID: "i1", title: "Beach", label: "Beach"))

    XCTAssertEqual(handle.kind, .scene)
    XCTAssertEqual(handle.id, "664f1c2b9a1e4d0012ab34cd")
    XCTAssertEqual(handle.prompt, "Beach")
    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path(), "/api/v1/scene-compositions")
    let sent = try body(request)
    XCTAssertEqual(Set(sent.keys), ["video_file_id", "audio_file_id", "audio", "cover_file_id", "title"])
    let audio = try XCTUnwrap(sent["audio"] as? [String: Any])
    XCTAssertEqual(audio["fit"] as? String, "trim")
    XCTAssertEqual(Set(audio.keys), ["fit"], "an untouched fade is left to the server's default")
  }

  func testFadesOffSendsZeroFades() async throws {
    let transport = FakeTransport { _ in (202, Data(openAPIExampleJob.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    _ = try await client.composeScene(
      SceneRequest(videoFileID: "v1", audioFileID: "a1", fadeInSeconds: 0, fadeOutSeconds: 0))
    let requests = await transport.requests
    let audio = try XCTUnwrap(try body(try XCTUnwrap(requests.first))["audio"] as? [String: Any])
    XCTAssertEqual(audio["fade_in_seconds"] as? Double, 0)
    XCTAssertEqual(audio["fade_out_seconds"] as? Double, 0)
  }

  func testAMissingInputFileKeepsItsReason() async {
    let transport = FakeTransport { _ in
      (404, Data(#"{"error":"Video not found.","errorCode":"input_file_not_found"}"#.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.composeScene(SceneRequest(videoFileID: "v1", audioFileID: "a1"))
      XCTFail("expected a refusal")
    } catch let error as StudioRequestError {
      XCTAssertEqual(error.status, 404)
      XCTAssertEqual(error.code, "input_file_not_found")
    } catch {
      XCTFail("unexpected \(error)")
    }
  }

  func testOptionalKeysAreLeftOutNotNull() async throws {
    let transport = FakeTransport { _ in (202, Data(openAPIExampleJob.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    _ = try await client.composeScene(SceneRequest(videoFileID: "v1", audioFileID: "a1"))
    let requests = await transport.requests
    let sent = try body(try XCTUnwrap(requests.first))
    XCTAssertEqual(Set(sent.keys), ["video_file_id", "audio_file_id", "audio"], "the body is strict: no null, no org")
  }

  func testARefusalCarriesItsCode() async {
    let transport = FakeTransport { _ in
      (422, Data(#"{"error":"That file is not a video.","errorCode":"unsupported_input"}"#.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.composeScene(SceneRequest(videoFileID: "v1", audioFileID: "a1"))
      XCTFail("expected a refusal")
    } catch {
      XCTAssertEqual(
        StudioSubmitError(error), .rejected(code: "unsupported_input", message: "That file is not a video."))
    }
  }

  func testStatusAndCancelUseTheSceneRoutesAndReadTheOutputFile() async throws {
    let transport = FakeTransport { request in
      request.url?.path().hasSuffix("/cancel") == true
        ? (200, Data(openAPIExampleJob.utf8)) : (200, Data(succeededJob.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let handle = GenerationHandle(kind: .scene, id: "664f1c2b9a1e4d0012ab34cd", prompt: "Beach", startedAt: Date())

    let status = try await client.status(of: handle)
    try await client.cancel(handle)

    XCTAssertEqual(status.phase, .succeeded)
    XCTAssertEqual(status.resultURLs, [URL(string: "https://cdn.example.test/scene.mp4")!])
    XCTAssertEqual(status.resultFileID, "664f1c2b9a1e4d0012ab34ff")
    let paths = await transport.requests.map { $0.url?.path() }
    XCTAssertEqual(
      paths,
      [
        "/api/v1/scene-compositions/664f1c2b9a1e4d0012ab34cd",
        "/api/v1/scene-compositions/664f1c2b9a1e4d0012ab34cd/cancel",
      ])
  }

  func testThePendingExampleIsQueuedWithNoOutput() throws {
    let job = try StudioWire.decode(StudioWire.Job.self, from: Data(openAPIExampleJob.utf8))
    let status = StudioWire.status(of: job)
    XCTAssertEqual(status.phase, .queued)
    XCTAssertNil(status.resultFileID)
  }

  func testAFailedSceneMapsItsPublicCode() throws {
    let failed = Data(
      #"{"id":"j","state":"failed","error":{"code":"unsupported_input","message":"Bad file"},"output":null}"#.utf8)
    let status = StudioWire.status(of: try StudioWire.decode(StudioWire.Job.self, from: failed))
    XCTAssertEqual(status.phase, .failed(.other(code: "unsupported_input")))
  }

  func testAScenesHasNoModelsAndCannotBeGeneratedFromAPrompt() async throws {
    let transport = FakeTransport()
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let models = try await client.models(for: .scene)
    XCTAssertTrue(models.isEmpty)
    do {
      _ = try await client.generate(GenerationRequest(kind: .scene, prompt: "x", modelID: "m"))
      XCTFail("expected a refusal")
    } catch {
      XCTAssertEqual((error as? StudioRequestError)?.status, 422)
    }
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }

  func testComposeAccepts200AsWellAs202() async throws {
    let transport = FakeTransport { _ in (200, Data(openAPIExampleJob.utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let handle = try await client.composeScene(SceneRequest(videoFileID: "v1", audioFileID: "a1", label: "Beach"))
    XCTAssertEqual(handle.id, "664f1c2b9a1e4d0012ab34cd")
    XCTAssertEqual(handle.kind, .scene)
  }

  func testAnAcceptedComposeWithANonJSONBodyIsMalformed() async {
    let transport = FakeTransport { _ in (202, Data("accepted".utf8)) }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.composeScene(SceneRequest(videoFileID: "v1", audioFileID: "a1"))
      XCTFail("expected a malformed response")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testCancellingASceneTheServerCannotCancelKeepsItsCode() async {
    let transport = FakeTransport { _ in
      (409, Data(#"{"error":"Already finished.","errorCode":"not_cancellable"}"#.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let handle = GenerationHandle(kind: .scene, id: "664f1c2b9a1e4d0012ab34cd", prompt: "Beach", startedAt: Date())
    do {
      try await client.cancel(handle)
      XCTFail("expected a refusal")
    } catch let error as StudioRequestError {
      XCTAssertEqual(error.status, 409)
      XCTAssertEqual(error.code, "not_cancellable")
    } catch {
      XCTFail("unexpected \(error)")
    }
  }

  func testMusicAndVideoStatusAndCancelUseTheirJobRoutes() async throws {
    let transport = FakeTransport { request in
      request.url?.path().hasSuffix("/cancel") == true
        ? (200, Data(openAPIExampleJob.utf8)) : (200, Data(succeededJob.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    let music = GenerationHandle(kind: .music, id: "m1", prompt: "lofi", startedAt: Date())
    let video = GenerationHandle(kind: .video, id: "v1", prompt: "waves", startedAt: Date())

    _ = try await client.status(of: music)
    try await client.cancel(music)
    _ = try await client.status(of: video)
    try await client.cancel(video)

    let paths = await transport.requests.map { $0.url?.path() }
    XCTAssertEqual(
      paths,
      [
        "/api/v1/music-generations/m1",
        "/api/v1/music-generations/m1/cancel",
        "/api/v1/video-generations/v1",
        "/api/v1/video-generations/v1/cancel",
      ])
  }

  func testTheCreateBarDoesNotOfferScenes() {
    XCTAssertFalse(GenerationKind.promptable.contains(.scene))
    XCTAssertEqual(GenerationKind.scene.mediaKind, .video)
  }

  func testEveryKindMapsToItsGalleryMediaKind() {
    XCTAssertEqual(GenerationKind.image.mediaKind, .image)
    XCTAssertEqual(GenerationKind.video.mediaKind, .video)
    XCTAssertEqual(GenerationKind.music.mediaKind, .audio)
    XCTAssertEqual(GenerationKind.scene.mediaKind, .video)
  }
}

@MainActor
final class SceneTrackingTests: XCTestCase {
  func testASceneFrameTriggersAFetchThatRecordsTheOutputFile() async {
    let api = FakeStudioAPI()
    let realtime = FakeRealtime()
    let tracker = GenerationTracker(
      api: api, realtime: realtime, store: MemoryGenerationStore(),
      sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    tracker.resume()
    tracker.track(GenerationHandle(kind: .scene, id: "s1", prompt: "Beach", startedAt: Date()))
    await eventually { await realtime.listenerCount == 1 }

    await api.script("s1", [.success(GenerationStatus(phase: .succeeded, resultFileID: "f9"))])
    await realtime.emit(
      .frame(
        ActionFrame(
          action: "generation_job_updated",
          payload: ["job": .object(["id": .string("s1"), "kind": .string("compose"), "state": .string("succeeded")])])))

    await eventually { await MainActor.run { tracker.generations.first?.phase == .succeeded } }
    XCTAssertEqual(tracker.generations.first?.resultFileID, "f9")
  }

  func testPollingAloneSettlesAScene() async {
    let api = FakeStudioAPI()
    await api.script(
      "s2",
      [
        .success(GenerationStatus(phase: .running(progress: nil))),
        .success(GenerationStatus(phase: .succeeded, resultFileID: "f2")),
      ])
    let tracker = GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in await Task.yield() })
    tracker.track(GenerationHandle(kind: .scene, id: "s2", prompt: "Beach", startedAt: Date()))
    await eventually { await MainActor.run { tracker.generations.first?.resultFileID == "f2" } }
  }

  func testALaterStatusWithoutAFileKeepsTheRecordedOne() {
    let tracker = GenerationTracker(
      api: FakeStudioAPI(), realtime: nil, store: MemoryGenerationStore(),
      sleep: { _ in try await Task.sleep(for: .seconds(3600)) })
    tracker.track(GenerationHandle(kind: .scene, id: "s3", prompt: "Beach", startedAt: Date()))

    tracker.apply(GenerationStatus(phase: .running(progress: 0.5), resultFileID: "f3"), to: "s3")
    tracker.apply(GenerationStatus(phase: .running(progress: 0.9)), to: "s3")

    XCTAssertEqual(tracker.generations.first?.resultFileID, "f3")
  }
}

/// Lists by kind, so the composer's partner and cover lists can be told apart.
private actor KindedMediaAPI: MediaAPI {
  private(set) var listed: [MediaKind?] = []
  let items: [MediaItem]
  let failing: MediaKind?

  init(_ items: [MediaItem], failing: MediaKind? = nil) {
    self.items = items
    self.failing = failing
  }

  func listMedia(kind: MediaKind?, page: Int, limit: Int) async throws -> MediaPage {
    listed.append(kind)
    if let failing, kind == failing { throw APIError.notFound }
    return MediaPage(items: items.filter { kind == nil || $0.kind == kind }, hasMore: false)
  }

  func media(id: String) async throws -> MediaItem { throw APIError.notFound }
}

/// A compose call that stays in flight until `release()`, to prove a second submit is turned away.
private actor GatedSceneAPI: StudioAPI {
  private(set) var calls = 0
  private var waiter: CheckedContinuation<Void, Never>?

  func release() {
    waiter?.resume()
    waiter = nil
  }

  func models(for kind: GenerationKind) async throws -> [GenerationModel] { [] }
  func generate(_ request: GenerationRequest) async throws -> [GenerationHandle] { throw APIError.notFound }
  func editImage(_ request: ImageEditRequest) async throws -> GenerationHandle { throw APIError.notFound }

  func composeScene(_ request: SceneRequest) async throws -> GenerationHandle {
    calls += 1
    await withCheckedContinuation { waiter = $0 }
    return GenerationHandle(kind: .scene, id: "gated-\(calls)", prompt: request.label, startedAt: Date())
  }

  func status(of handle: GenerationHandle) async throws -> GenerationStatus {
    GenerationStatus(phase: .running(progress: nil))
  }

  func cancel(_ handle: GenerationHandle) async throws {}
}

@MainActor
final class SceneComposerViewModelTests: XCTestCase {
  private func makeTracker(_ api: FakeStudioAPI) -> GenerationTracker {
    GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )
  }

  func testLoadsThePartnerKindAndCoversThenSubmitsAndTracks() async throws {
    let api = FakeStudioAPI()
    let tracker = makeTracker(api)
    let media = KindedMediaAPI([clip, song, art])
    let model = SceneComposerViewModel(
      draft: try XCTUnwrap(SceneDraft.starting(from: clip)), api: api, media: media, tracker: tracker)

    await model.load()
    XCTAssertEqual(model.partners, .loaded([song]))
    XCTAssertEqual(model.covers, .loaded([art]))
    XCTAssertFalse(model.canSubmit)

    model.pick(song)
    model.pick(art)
    XCTAssertEqual(model.openSlot, .audio, "the list stays open after a pick")
    XCTAssertTrue(model.canSubmit)
    let started = await model.submit()

    XCTAssertTrue(started)
    let sent = await api.scenes
    XCTAssertEqual(sent.map(\.audioFileID), ["a1"])
    XCTAssertEqual(sent.first?.coverFileID, "i1")
    XCTAssertEqual(tracker.generations.first?.handle.kind, .scene)
  }

  func testAFailedPartnerListLeavesTheCoversLoaded() async throws {
    let media = KindedMediaAPI([clip, song, art], failing: .audio)
    let model = SceneComposerViewModel(
      draft: try XCTUnwrap(SceneDraft.starting(from: clip)), api: FakeStudioAPI(), media: media,
      tracker: makeTracker(FakeStudioAPI()))

    await model.load()

    XCTAssertEqual(model.partners, .failed)
    XCTAssertEqual(model.covers, .loaded([art]))
  }

  func testATitleOverTheServersLimitIsHeldBackByUTF16Length() {
    let emoji = String(repeating: "\u{1F3D6}", count: 150)
    XCTAssertEqual(emoji.count, 150)
    XCTAssertNotNil(SceneDraft(video: clip, audio: song, title: emoji).issue)
    XCTAssertNil(SceneDraft(video: clip, audio: song, title: String(repeating: "a", count: 200)).issue)
  }

  func testARefusalStaysOnTheSheetWithItsReason() async {
    let api = FakeStudioAPI()
    await api.failGenerate(
      with: StudioRequestError(status: 422, code: "limit_exceeded", serverMessage: "That video is too long."))
    let tracker = makeTracker(api)
    let model = SceneComposerViewModel(
      draft: SceneDraft(video: clip, audio: song), api: api, media: KindedMediaAPI([]), tracker: tracker)

    let started = await model.submit()

    XCTAssertFalse(started)
    XCTAssertEqual(model.error, .rejected(code: "limit_exceeded", message: "That video is too long."))
    XCTAssertTrue(tracker.generations.isEmpty)
  }

  func testASecondSubmitWhileTheFirstIsInFlightSendsNothing() async throws {
    let api = GatedSceneAPI()
    let tracker = makeTracker(FakeStudioAPI())
    let model = SceneComposerViewModel(
      draft: SceneDraft(video: clip, audio: song), api: api, media: KindedMediaAPI([]), tracker: tracker)

    let first = Task { await model.submit() }
    await eventually { await api.calls == 1 }
    XCTAssertTrue(model.isSubmitting)
    XCTAssertFalse(model.canSubmit)

    let second = await model.submit()
    await api.release()
    let firstStarted = await first.value

    XCTAssertFalse(second)
    XCTAssertTrue(firstStarted)
    let calls = await api.calls
    XCTAssertEqual(calls, 1)
    XCTAssertEqual(tracker.generations.count, 1)
    XCTAssertFalse(model.isSubmitting)
  }

  func testPickingAFileClearsAPreviousError() {
    let model = SceneComposerViewModel(
      draft: SceneDraft(video: clip), api: FakeStudioAPI(), media: KindedMediaAPI([]),
      tracker: makeTracker(FakeStudioAPI()))
    model.error = .api(.offline)

    model.pick(song)

    XCTAssertNil(model.error)
    XCTAssertEqual(model.draft.audio, song)
  }

  func testACompleteDraftHasNoOpenSlotAndOnlyListsCovers() async {
    let media = KindedMediaAPI([clip, song, art])
    let model = SceneComposerViewModel(
      draft: SceneDraft(video: clip, audio: song), api: FakeStudioAPI(), media: media,
      tracker: makeTracker(FakeStudioAPI()))

    await model.load()

    XCTAssertNil(model.openSlot)
    XCTAssertEqual(model.partners, .loaded([]))
    XCTAssertEqual(model.covers, .loaded([art]))
    let listed = await media.listed
    XCTAssertEqual(listed, [.image])
    XCTAssertTrue(model.canSubmit)
  }
}
