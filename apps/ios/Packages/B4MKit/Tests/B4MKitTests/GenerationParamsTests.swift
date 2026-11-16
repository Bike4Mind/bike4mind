import XCTest

@testable import B4MKit

/// The params panel's data layer: capabilities decoded from the v1 model lists, the controls built from them,
/// carry-over on a model switch, the credit estimate and the request bodies.
@MainActor
final class GenerationParamsTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  // Shapes copied from the v1 contracts' examples (video-models, music-models, models image block).
  private let videoModels = #"""
    {"models":[
      {"id":"grok-imagine-video-1.5","object":"video_model","display_name":"Grok Imagine Video 1.5","provider":"xai",
       "modes":["text_to_video","image_to_video"],"input_roles":[{"role":"first_frame","max":1}],
       "duration":{"kind":"range","min":1,"max":15,"step":1},
       "aspect_ratios":["16:9","9:16","1:1"],"resolutions":["480p","720p"],
       "defaults":{"duration_seconds":6,"aspect_ratio":"16:9","resolution":"480p"},
       "audio":"always","credits_per_second":{"480p":160,"720p":280},"deprecation_date":null},
      {"id":"veo","display_name":"Veo","modes":["text_to_video"],"input_roles":[],
       "duration":{"kind":"discrete","values":[4,6,8]},"aspect_ratios":["16:9"],"resolutions":["720p","1080p"],
       "defaults":{"duration_seconds":8,"aspect_ratio":"16:9","resolution":"720p"},
       "audio":"optional","credits_per_second":null,"deprecation_date":null}
    ]}
    """#

  private let musicModels = #"""
    {"models":[
      {"id":"lyria-3.5","object":"music_model","display_name":"Lyria 3.5","provider":"gemini-lyria","vocals":"optional",
       "lyrics":{"max_chars":10000,"max_line_chars":null},
       "duration":{"control":"approximate","min":30,"max":180,"default":120},"output_formats":["mp3"],
       "pricing":{"unit":"per_song","credits":160},"preview":false,"deprecation_date":null},
      {"id":"loops","display_name":"Loops","vocals":"never","lyrics":null,"duration":{"control":"fixed","seconds":30},
       "pricing":{"unit":"per_second","credits":3},"deprecation_date":null}
    ]}
    """#

  private let imageModels = #"""
    {"data":[
      {"id":"gpt-image-2","name":"GPT Image 2","type":"image","deprecation_date":null,
       "image":{"sizing":{"kind":"constrained","presets":["1024x1024","1536x1024"],"default_size":"1024x1024",
         "auto_size":"auto","constraints":{"max_edge":3840,"min_total_pixels":1,"max_total_pixels":9,"edge_multiple":16,
         "max_aspect_ratio":3}},
         "supports":{"transparent_background":true,"seed":false,"qualities":["low","medium","high","auto"],
           "max_images":4,"max_reference_images":15,"edit":true,"requires_input_image":false}}},
      {"id":"flux-3-image","name":"FLUX 3","type":"image","deprecation_date":null,
       "image":{"sizing":{"kind":"aspect_ratio"},
         "supports":{"transparent_background":false,"seed":true,"qualities":[],"max_images":1,
           "max_reference_images":4,"edit":true,"requires_input_image":false}}},
      {"id":"gpt-4o","name":"GPT-4o","type":"text","deprecation_date":null,"image":null}
    ],"next_cursor":null}
    """#

  private func models(_ kind: GenerationKind, _ json: String) async throws -> [GenerationModel] {
    let transport = FakeTransport { _ in (200, Data(json.utf8)) }
    return try await StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport).models(for: kind)
  }

  private func body(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
  }

  // MARK: Decoding and controls

  func testVideoModelsBecomeControlsWithTheirRealBoundsAndDefaults() async throws {
    let list = try await models(.video, videoModels)
    let grok = try XCTUnwrap(list.first)
    let controls = ParamControls.controls(for: grok.capabilities, params: GenerationParams())

    XCTAssertEqual(controls.map(\.key), [.aspectRatio, .duration, .resolution], "audio is always on, so no control")
    XCTAssertEqual(controls[1].kind, .range(min: 1, max: 15, step: 1))
    XCTAssertEqual(controls[1].defaultValue, .number(6))
    XCTAssertEqual(controls[2].defaultValue, .text("480p"))
    guard case .video(let video)? = grok.capabilities else { return XCTFail("expected video capabilities") }
    XCTAssertEqual(video.inputRoles, ["first_frame": 1])

    let veo = ParamControls.controls(for: list[1].capabilities, params: GenerationParams())
    XCTAssertEqual(veo.map(\.key), [.aspectRatio, .duration, .resolution, .audio])
    XCTAssertEqual(veo[1].kind, .choice([4, 6, 8].map { ParamOption(value: .number($0), label: "\(Int($0))s") }))
    XCTAssertNil(veo[3].defaultValue, "the provider decides audio when it is left alone")
  }

  func testMusicLyricsGoAwayForAnInstrumentalAndInstrumentalOnlyModelsHaveNoToggle() async throws {
    let list = try await models(.music, musicModels)
    let lyria = list[0].capabilities

    XCTAssertEqual(
      ParamControls.controls(for: lyria, params: GenerationParams()).map(\.key), [.duration, .instrumental, .lyrics])
    XCTAssertEqual(
      ParamControls.controls(for: lyria, params: GenerationParams([.instrumental: .flag(true)])).map(\.key),
      [.duration, .instrumental])
    XCTAssertEqual(ParamControls.controls(for: list[1].capabilities, params: GenerationParams()).map(\.key), [])
  }

  func testImageModelsOfferOnlyWhatTheirBlockAdvertises() async throws {
    let list = try await models(.image, imageModels)

    XCTAssertEqual(list.map(\.id), ["gpt-image-2", "flux-3-image"])
    let gpt = ParamControls.controls(for: list[0].capabilities, params: GenerationParams())
    XCTAssertEqual(gpt.map(\.key), [.size, .quality, .count, .transparentBackground])
    XCTAssertEqual(gpt[0].defaultValue, .text("1024x1024"))
    XCTAssertEqual(
      gpt[1].kind,
      .choice(["low", "medium", "high", "auto"].map { ParamOption(value: .text($0), label: $0.capitalized) }),
      "auto is a real choice: an omitted quality is the server's default, not auto")
    XCTAssertNil(gpt[1].defaultValue, "no quality is sent until one is picked")
    XCTAssertEqual(gpt[2].kind, .range(min: 1, max: 4, step: 1))
    XCTAssertEqual(
      ParamControls.controls(for: list[1].capabilities, params: GenerationParams()).map(\.key), [.seed],
      "an aspect-ratio model takes no size, and the list names no ratios for it yet")
  }

  func testControlsAcceptOnlyValuesInsideTheirBounds() {
    let duration = ParamControl(
      key: .duration, title: "Duration", kind: .range(min: 30, max: 180, step: 5), defaultValue: nil)
    XCTAssertTrue(duration.accepts(.number(35)))
    XCTAssertFalse(duration.accepts(.number(33)), "off the step")
    XCTAssertFalse(duration.accepts(.number(185)))
    XCTAssertFalse(duration.accepts(.text("35")))

    let seed = ParamControl(key: .seed, title: "Seed", kind: .seed, defaultValue: nil)
    XCTAssertTrue(seed.accepts(.number(42)))
    XCTAssertFalse(seed.accepts(.number(-1)))
    XCTAssertFalse(seed.accepts(.number(1.5)))
    XCTAssertFalse(seed.accepts(.number(ParamControl.maximumSeed + 1)))
  }

  // MARK: Carry-over and summary

  func testSwitchingModelKeepsWhatFitsAndNamesWhatWasDropped() async throws {
    let list = try await models(.video, videoModels)
    let veoParams = GenerationParams([.aspectRatio: .text("16:9"), .resolution: .text("1080p"), .audio: .flag(false)])

    let (kept, dropped) = veoParams.carried(to: list[0].capabilities)

    XCTAssertEqual(kept, GenerationParams(), "16:9 is grok's default, so it is no longer a change")
    XCTAssertEqual(Set(dropped), [.resolution, .audio])
  }

  func testTheCreateBarNamesDroppedSettingsAndSummarisesChanges() async throws {
    let api = FakeStudioAPI()
    let list = try await models(.video, videoModels)
    await api.setModels(.video, list)
    let model = StudioCreateViewModel(
      api: api,
      tracker: GenerationTracker(
        api: api, realtime: nil, store: MemoryGenerationStore(),
        sleep: { _ in try await Task.sleep(for: .seconds(3600)) }))
    model.kind = .video
    await model.loadModels()
    model.select(model: list[1])
    let controls = model.controls
    model.set(.text("1080p"), for: try XCTUnwrap(controls.first { $0.key == .resolution }))
    model.set(.number(4), for: try XCTUnwrap(controls.first { $0.key == .duration }))
    model.set(.flag(false), for: try XCTUnwrap(controls.first { $0.key == .audio }))
    XCTAssertEqual(model.paramsSummary, "4s \u{00B7} 1080p \u{00B7} Silent")

    model.select(model: list[0])

    XCTAssertEqual(model.params, GenerationParams([.duration: .number(4)]))
    XCTAssertEqual(model.paramsNote, "Grok Imagine Video 1.5 doesn't take resolution or audio, so it was reset.")
    XCTAssertEqual(model.estimatedCredits, 640, "4s at the 480p default of 160 credits a second")
  }

  func testUsingSettingsOfARemovedModelSaysWhichModelIsUsedAndKeepsATypedPrompt() async throws {
    let api = FakeStudioAPI()
    let list = try await models(.video, videoModels)
    await api.setModels(.video, list)
    let model = StudioCreateViewModel(
      api: api,
      tracker: GenerationTracker(
        api: api, realtime: nil, store: MemoryGenerationStore(),
        sleep: { _ in try await Task.sleep(for: .seconds(3600)) }))
    let gone = GenerationHandle(
      kind: .video, id: "j1", prompt: "waves", startedAt: Date(timeIntervalSince1970: 0), modelID: "retired",
      params: GenerationParams())

    await model.use(settingsOf: gone)

    XCTAssertEqual(model.selectedModel?.id, "grok-imagine-video-1.5")
    XCTAssertEqual(
      model.paramsNote, "The original model isn't available, so this uses Grok Imagine Video 1.5.",
      "nothing was dropped, but the model still changed")
    XCTAssertEqual(model.prompt, "waves")

    model.prompt = "a lighthouse"
    let veo = GenerationHandle(
      kind: .video, id: "j2", prompt: "waves", startedAt: Date(timeIntervalSince1970: 0), modelID: "veo",
      params: GenerationParams([.duration: .number(4)]))
    await model.use(settingsOf: veo)

    XCTAssertEqual(model.selectedModel?.id, "veo")
    XCTAssertEqual(model.params, GenerationParams([.duration: .number(4)]))
    XCTAssertNil(model.paramsNote)
    XCTAssertEqual(model.prompt, "a lighthouse", "a typed prompt is not overwritten")
  }

  // MARK: Cost

  func testCreditEstimatesFollowTheAdvertisedPricing() async throws {
    let video = try await models(.video, videoModels)
    XCTAssertEqual(CreditEstimate.credits(for: video[0].capabilities, params: GenerationParams()), 960)
    XCTAssertEqual(
      CreditEstimate.credits(
        for: video[0].capabilities, params: GenerationParams([.resolution: .text("720p"), .duration: .number(10)])),
      2800)
    XCTAssertNil(CreditEstimate.credits(for: video[1].capabilities, params: GenerationParams()), "priced per clip")

    let music = try await models(.music, musicModels)
    XCTAssertEqual(CreditEstimate.credits(for: music[0].capabilities, params: GenerationParams()), 160)
    XCTAssertEqual(CreditEstimate.credits(for: music[1].capabilities, params: GenerationParams()), 90)

    let images = try await models(.image, imageModels)
    XCTAssertNil(CreditEstimate.credits(for: images[0].capabilities, params: GenerationParams()))
  }

  // MARK: Request bodies

  func testChangedValuesReachTheWireAndDefaultsStayOff() async throws {
    let transport = FakeTransport { request in
      request.url?.path() == "/api/v1/image-generations"
        ? (200, Data(#"{"quest":{"id":"q1"}}"#.utf8)) : (202, Data(#"{"id":"j1","state":"pending"}"#.utf8))
    }
    let client = StudioClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    _ = try await client.generate(
      GenerationRequest(
        kind: .image, prompt: "a fox", modelID: "gpt-image-2",
        params: GenerationParams([
          .size: .text("1536x1024"), .quality: .text("high"), .count: .number(2), .seed: .number(42),
          .transparentBackground: .flag(true),
        ])))
    _ = try await client.generate(
      GenerationRequest(
        kind: .video, prompt: "waves", modelID: "veo",
        params: GenerationParams([.duration: .number(4), .aspectRatio: .text("16:9"), .audio: .flag(false)])))
    _ = try await client.generate(
      GenerationRequest(
        kind: .music, prompt: "lofi", modelID: "lyria-3.5",
        params: GenerationParams([.duration: .number(90), .lyrics: .text("la la")])))
    _ = try await client.generate(
      GenerationRequest(
        kind: .music, prompt: "lofi", modelID: "lyria-3.5",
        params: GenerationParams([.instrumental: .flag(true), .lyrics: .text("stale")])))
    _ = try await client.generate(GenerationRequest(kind: .image, prompt: "plain", modelID: "gpt-image-2"))

    let sent = try await transport.requests.map(body)
    XCTAssertEqual(sent[0]["size"] as? String, "1536x1024")
    XCTAssertEqual(sent[0]["quality"] as? String, "high")
    XCTAssertEqual(sent[0]["n"] as? Int, 2)
    XCTAssertEqual(sent[0]["seed"] as? Int, 42)
    XCTAssertEqual(sent[0]["background"] as? String, "transparent")
    XCTAssertEqual(
      Set(sent[1].keys), ["model", "prompt", "duration_seconds", "aspect_ratio", "audio", "organization_id"])
    XCTAssertEqual(sent[1]["audio"] as? Bool, false)
    XCTAssertEqual(Set(sent[2].keys), ["model", "prompt", "duration_seconds", "lyrics", "organization_id"])
    XCTAssertEqual(
      Set(sent[3].keys), ["model", "prompt", "instrumental", "organization_id"],
      "the server refuses lyrics on an instrumental")
    XCTAssertEqual(
      Set(sent[4].keys), ["prompt", "model", "n", "prompt_resolution", "organization_id"],
      "an untouched panel sends only the defaults the route needs")
  }

  // MARK: Errors and persistence

  func testAValidationRefusalShowsTheServersOwnReason() {
    let rejected = StudioSubmitError(
      StudioRequestError(status: 422, code: "unsupported_resolution", serverMessage: "Veo can't render 4k."))
    XCTAssertEqual(rejected, .rejected(code: "unsupported_resolution", message: "Veo can't render 4k."))

    let credits = StudioSubmitError(
      StudioRequestError(status: 402, code: "insufficient_credits", serverMessage: "Not enough credits"))
    XCTAssertEqual(credits, .refused(.insufficientCredits), "known codes keep the app's own guidance")
  }

  func testHandlesPersistedBeforeParamsStillDecode() throws {
    let legacy = Data(#"{"kind":"video","id":"j1","prompt":"waves","startedAt":0}"#.utf8)
    let handle = try JSONDecoder().decode(GenerationHandle.self, from: legacy)
    XCTAssertNil(handle.params)

    let current = GenerationHandle(
      kind: .video, id: "j2", prompt: "waves", startedAt: Date(timeIntervalSince1970: 0), modelID: "veo",
      params: GenerationParams([.duration: .number(4), .audio: .flag(false)]))
    XCTAssertEqual(try JSONDecoder().decode(GenerationHandle.self, from: try JSONEncoder().encode(current)), current)
  }

  func testPersistedNumbersNeverDecodeAsFlags() throws {
    let values: [ParamValue] = [.number(0), .number(1), .flag(false), .flag(true), .text("1")]
    let decoded = try JSONDecoder().decode([ParamValue].self, from: try JSONEncoder().encode(values))
    XCTAssertEqual(decoded, values)
  }
}
