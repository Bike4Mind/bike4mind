import XCTest

@testable import B4MKit

private func image(_ id: String, prompt: String? = "a fox") -> MediaItem {
  MediaItem(id: id, kind: .image, fileName: "\(id).png", mimeType: "image/png", createdAt: Date(), prompt: prompt)
}

private let clip = MediaItem(id: "v1", kind: .video, fileName: "v1.mp4", mimeType: "video/mp4", createdAt: Date())
private let track = MediaItem(id: "a1", kind: .audio, fileName: "a1.mp3", mimeType: "audio/mpeg", createdAt: Date())

final class TurnIntoPlannerTests: XCTestCase {
  func testActionsFollowTheSourceMedium() {
    XCTAssertEqual(TurnInto.actions(for: image("i1")), [.animate, .arriveAt, .morph])
    XCTAssertEqual(TurnInto.actions(for: clip), [.grabFrame])
    XCTAssertEqual(TurnInto.actions(for: track), [])
  }

  func testAnimateMakesTheImageTheFirstFrameAndCopiesItsPrompt() throws {
    let seed = try XCTUnwrap(TurnInto.seed(.animate, from: image("i1")))
    XCTAssertEqual(seed.kind, .video)
    XCTAssertEqual(seed.prompt, "a fox")
    XCTAssertEqual(seed.inputs.map(\.role), [.firstFrame])
  }

  func testArriveAtKeepsAttachedStartFrameAndReplacesAnOldEndFrame() throws {
    let current = [
      StudioInput(role: .firstFrame, item: image("start")), StudioInput(role: .lastFrame, item: image("old")),
      StudioInput(role: .style, item: image("look")),
    ]
    let seed = try XCTUnwrap(TurnInto.seed(.arriveAt, from: image("end"), current: current))
    XCTAssertEqual(seed.inputs.map(\.id), ["first_frame:start", "last_frame:end", "style:look"])
  }

  func testMorphNeedsADifferentSecondImage() throws {
    XCTAssertNil(TurnInto.seed(.morph, from: image("i1")))
    XCTAssertNil(TurnInto.seed(.morph, from: image("i1"), secondImage: image("i1")))
    XCTAssertNil(TurnInto.seed(.morph, from: image("i1"), secondImage: clip))
    let seed = try XCTUnwrap(TurnInto.seed(.morph, from: image("i1"), secondImage: image("i2")))
    XCTAssertEqual(seed.inputs.map(\.id), ["first_frame:i1", "last_frame:i2"])
  }

  func testOnlyImagesSeedVideo() {
    XCTAssertNil(TurnInto.seed(.animate, from: clip))
  }
}

final class JobBodyInputsTests: XCTestCase {
  private func json(_ body: StudioWire.JobBody) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: StudioWire.encode(body)) as? [String: Any])
  }

  func testVideoSendsInputsAsFileIDAndRole() throws {
    let body = StudioWire.JobBody(
      kind: .video, model: "m", prompt: "p",
      inputs: [GenerationInput(role: "first_frame", fileID: "f1"), GenerationInput(role: "last_frame", fileID: "f2")])
    let inputs = try XCTUnwrap(json(body)["inputs"] as? [[String: String]])
    XCTAssertEqual(inputs, [["file_id": "f1", "role": "first_frame"], ["file_id": "f2", "role": "last_frame"]])
  }

  func testNoInputsOrMusicOmitsTheKey() throws {
    XCTAssertNil(try json(StudioWire.JobBody(kind: .video, model: "m", prompt: "p"))["inputs"])
    let music = StudioWire.JobBody(
      kind: .music, model: "m", prompt: "p", inputs: [GenerationInput(role: "first_frame", fileID: "f1")])
    XCTAssertNil(try json(music)["inputs"])
  }
}

@MainActor
final class StudioInputsViewModelTests: XCTestCase {
  private let textOnly = GenerationModel(
    id: "text", name: "Text", capabilities: .video(VideoCapabilities(modes: ["text_to_video"])))
  private let animator = GenerationModel(
    id: "anim", name: "Animator",
    capabilities: .video(
      VideoCapabilities(modes: ["text_to_video", "image_to_video"], inputRoles: ["first_frame": 1])))
  private let morpher = GenerationModel(
    id: "morph", name: "Morpher",
    capabilities: .video(
      VideoCapabilities(
        modes: ["image_to_video"], inputRoles: ["first_frame": 1, "last_frame": 1], defaultDuration: 5)))

  private func make() async -> (StudioCreateViewModel, FakeStudioAPI) {
    let api = FakeStudioAPI()
    await api.setModels(.video, [textOnly, animator, morpher])
    let tracker = GenerationTracker(
      api: api, realtime: nil, store: MemoryGenerationStore(), sleep: { _ in try await Task.sleep(for: .seconds(3600)) }
    )
    return (StudioCreateViewModel(api: api, tracker: tracker), api)
  }

  func testWithoutInputsOnlyTextToVideoModelsAreOffered() async {
    let (model, _) = await make()
    model.kind = .video
    await model.loadModels()
    XCTAssertEqual(model.availableModels.map(\.id), ["text", "anim"])
  }

  func testAnimateOffersModelsThatTakeAFirstFrameAndPrefillsThePrompt() async throws {
    let (model, _) = await make()
    await model.apply(try XCTUnwrap(TurnInto.seed(.animate, from: image("i1"))))
    XCTAssertEqual(model.kind, .video)
    XCTAssertEqual(model.prompt, "a fox")
    XCTAssertEqual(model.availableModels.map(\.id), ["anim", "morph"])
    XCTAssertNil(model.inputIssue)
  }

  func testMorphNarrowsToModelsWithBothFramesAndSwitchesAnIncompatibleSelection() async throws {
    let (model, _) = await make()
    await model.apply(try XCTUnwrap(TurnInto.seed(.animate, from: image("i1"))))
    model.select(model: animator)
    await model.apply(try XCTUnwrap(TurnInto.seed(.morph, from: image("i1"), secondImage: image("i2"))))
    XCTAssertEqual(model.availableModels.map(\.id), ["morph"])
    XCTAssertEqual(model.selectedModel?.id, "morph")
    XCTAssertNotNil(model.paramsNote)
  }

  func testEndFrameAloneCannotSubmitUntilAStartFrameIsAdded() async throws {
    let (model, _) = await make()
    await model.apply(try XCTUnwrap(TurnInto.seed(.arriveAt, from: image("end"))))
    XCTAssertNotNil(model.inputIssue)
    XCTAssertFalse(model.canSubmit)
  }

  func testSubmitSendsInputsThenClearsThem() async throws {
    let (model, api) = await make()
    await model.apply(try XCTUnwrap(TurnInto.seed(.morph, from: image("i1"), secondImage: image("i2"))))
    model.prompt = "  fox leaps  "
    let started = await model.submit()
    XCTAssertTrue(started)
    let generated = await api.generated
    let request = try XCTUnwrap(generated.first)
    XCTAssertEqual(request.modelID, "morph")
    XCTAssertEqual(
      request.inputs,
      [GenerationInput(role: "first_frame", fileID: "i1"), GenerationInput(role: "last_frame", fileID: "i2")])
    XCTAssertTrue(model.inputs.isEmpty)
  }

  func testRemovingTheLastInputReturnsToTextToVideo() async throws {
    let (model, _) = await make()
    await model.apply(try XCTUnwrap(TurnInto.seed(.animate, from: image("i1"))))
    model.remove(input: try XCTUnwrap(model.inputs.first))
    XCTAssertEqual(model.availableModels.map(\.id), ["text", "anim"])
  }

  func testAnExistingPromptIsKeptWhenTheSourceHasNone() async throws {
    let (model, _) = await make()
    model.prompt = "my words"
    await model.apply(try XCTUnwrap(TurnInto.seed(.animate, from: image("i1", prompt: nil))))
    XCTAssertEqual(model.prompt, "my words")
  }
}

final class FrameUploaderTests: XCTestCase {
  private func uploader(
    capture: FakeCaptureAPI, media: FakeMediaAPI, puts: Locked<[Int]> = Locked([])
  ) -> FrameUploader {
    FrameUploader(
      capture: capture, media: media,
      put: { _, data, type in
        XCTAssertEqual(type, "image/jpeg")
        puts.mutate { $0.append(data.count) }
      }, sleep: { _ in })
  }

  func testUploadsWaitsForTheScanAndReturnsTheImage() async throws {
    let capture = FakeCaptureAPI()
    await capture.setStatuses([.pending, .scanning, .clean])
    let media = FakeMediaAPI()
    await media.setDetail([image("file-1")])
    let puts = Locked<[Int]>([])
    let item = try await uploader(capture: capture, media: media, puts: puts).upload(
      jpeg: Data(repeating: 1, count: 9), fileName: "frame.jpg")
    XCTAssertEqual(item.id, "file-1")
    XCTAssertEqual(puts.current, [9])
    let calls = await capture.calls
    XCTAssertEqual(calls.first, .createUpload(name: "frame.jpg", mime: "image/jpeg", size: 9))
    XCTAssertEqual(calls.filter { $0 == .fileStatus("file-1") }.count, 3)
  }

  func testABlockedScanFails() async {
    let capture = FakeCaptureAPI()
    await capture.setStatuses([.blocked])
    do {
      _ = try await uploader(capture: capture, media: FakeMediaAPI()).upload(jpeg: Data([1]), fileName: "f.jpg")
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? FrameUploadError, .blocked)
    }
  }

  func testAScanThatNeverFinishesGivesUp() async {
    let capture = FakeCaptureAPI()
    await capture.setStatuses([.scanning])
    do {
      _ = try await uploader(capture: capture, media: FakeMediaAPI()).upload(jpeg: Data([1]), fileName: "f.jpg")
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? FrameUploadError, .notReady)
    }
  }

  func testAnAPIFailureIsWrapped() async {
    let capture = FakeCaptureAPI()
    await capture.setCreateUploadError(APIError.offline)
    do {
      _ = try await uploader(capture: capture, media: FakeMediaAPI()).upload(jpeg: Data([1]), fileName: "f.jpg")
      XCTFail("expected a failure")
    } catch {
      XCTAssertEqual(error as? FrameUploadError, .api(.offline))
    }
  }
}
