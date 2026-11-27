import XCTest

@testable import B4MKit

/// Speech synthesis with a scripted outcome per text. With `holding`, each call waits for `release()`.
actor FakeSpeechWire: VoiceAPI {
  private(set) var requested: [String] = []
  private var failures: [String: VoiceWireError] = [:]
  private var holding = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func fail(_ text: String, with error: VoiceWireError) { failures[text] = error }
  func setHolding(_ holding: Bool) { self.holding = holding }

  func release() {
    holding = false
    waiters.forEach { $0.resume() }
    waiters = []
  }

  func voiceSessionsEnabled() async throws -> Bool { true }
  func listVoices() async throws -> [VoiceOption] { [] }

  func synthesizeSpeech(text: String, voiceID: String) async throws -> Data {
    requested.append(text)
    if holding { await withCheckedContinuation { waiters.append($0) } }
    if let failure = failures[text] { throw failure }
    return Data("clip:\(voiceID):\(text)".utf8)
  }
}

actor FakeClipPlayer: AudioClipPlaying {
  private(set) var played: [String] = []
  private(set) var stopCount = 0
  var rejectsClips = false

  func setRejectsClips(_ rejects: Bool) { rejectsClips = rejects }

  func play(_ clip: Data) throws {
    if rejectsClips { throw AVAudioClipError() }
    played.append(String(decoding: clip, as: UTF8.self))
  }

  func stop() { stopCount += 1 }

  struct AVAudioClipError: Error {}
}

@MainActor
final class ServerSpeechSpeakerTests: XCTestCase {
  private let wire = FakeSpeechWire()
  private let player = FakeClipPlayer()
  private let fallback = FakeSpeaker()

  private func makeSpeaker() -> ServerSpeechSpeaker {
    ServerSpeechSpeaker(wire: wire, voiceID: "v1", fallback: fallback, player: player)
  }

  func testAClipIsFetchedInThePickedVoiceAndPlayed() async {
    let speaker = makeSpeaker()
    await speaker.speak("Hello there.")
    let played = await player.played
    let onDevice = await fallback.spoken
    XCTAssertEqual(played, ["clip:v1:Hello there."])
    XCTAssertEqual(onDevice, [])
    XCTAssertFalse(speaker.isDegraded)
  }

  func testEveryFailureSpeaksOnDeviceAndStaysThere() async {
    let failures: [VoiceWireError] = [
      .pending, .insufficientCredits, .rejected(status: 422), .rateLimited, .server(status: 500), .offline,
      .signedOut, .malformedResponse, .unavailable,
    ]
    for failure in failures {
      let wire = FakeSpeechWire()
      let player = FakeClipPlayer()
      let fallback = FakeSpeaker()
      await wire.fail("One.", with: failure)
      let speaker = ServerSpeechSpeaker(wire: wire, voiceID: "v1", fallback: fallback, player: player)

      await speaker.speak("One.")
      await speaker.speak("Two.")

      let onDevice = await fallback.spoken
      let requested = await wire.requested
      let played = await player.played
      XCTAssertEqual(onDevice, ["One.", "Two."], "\(failure)")
      XCTAssertEqual(requested, ["One."], "no further calls after \(failure)")
      XCTAssertEqual(played, [], "\(failure)")
      XCTAssertTrue(speaker.isDegraded, "\(failure)")
    }
  }

  func testAnUndecodableClipFallsBackAndLatches() async {
    await player.setRejectsClips(true)
    let speaker = makeSpeaker()
    await speaker.speak("One.")
    await speaker.speak("Two.")
    let onDevice = await fallback.spoken
    let requested = await wire.requested
    XCTAssertEqual(onDevice, ["One.", "Two."])
    XCTAssertEqual(requested, ["One."])
  }

  func testStopMidFetchNeverPlaysTheLateClip() async throws {
    await wire.setHolding(true)
    let speaker = makeSpeaker()
    let speaking = Task { await speaker.speak("Late.") }
    try await waitFor { await self.wire.requested == ["Late."] }

    await speaker.stop()
    await wire.release()
    await speaking.value

    let played = await player.played
    let onDevice = await fallback.spoken
    let stops = await player.stopCount
    XCTAssertEqual(played, [])
    XCTAssertEqual(onDevice, [], "a stopped chunk is not spoken on-device either")
    XCTAssertEqual(stops, 1)
    XCTAssertFalse(speaker.isDegraded, "stopping is not a failure")
  }

  func testAPreparedClipIsReusedNotFetchedTwice() async throws {
    let speaker = makeSpeaker()
    speaker.prepare("One.")
    speaker.prepare("Two.")
    try await waitFor { await self.wire.requested.count == 2 }
    await speaker.speak("One.")
    await speaker.speak("Two.")
    let requested = await wire.requested
    let played = await player.played
    XCTAssertEqual(requested, ["One.", "Two."])
    XCTAssertEqual(played, ["clip:v1:One.", "clip:v1:Two."])
  }

  func testPrefetchingStopsAtTheLimit() async throws {
    let speaker = makeSpeaker()
    for text in ["One.", "Two.", "Three.", "Four."] { speaker.prepare(text) }
    try await Task.sleep(for: .milliseconds(50))
    let requested = await wire.requested
    XCTAssertEqual(requested.count, ServerSpeechSpeaker.prefetchLimit)
    XCTAssertEqual(Set(requested), ["One.", "Two."])

    await speaker.speak("One.")
    try await waitFor { await self.wire.requested.contains("Three.") }
    let afterOne = await wire.requested
    XCTAssertEqual(afterOne.count, 3, "a queued chunk starts fetching once a slot frees, not when it is spoken")

    for text in ["Two.", "Three.", "Four."] { await speaker.speak(text) }
    let all = await wire.requested
    let played = await player.played
    XCTAssertEqual(all.count, 4, "no chunk is fetched twice")
    XCTAssertEqual(played, ["One.", "Two.", "Three.", "Four."].map { "clip:v1:\($0)" })
  }

  func testAnUnpreparedChunkIsFetchedWhenSpoken() async {
    let speaker = makeSpeaker()
    await speaker.speak("Solo.")
    let requested = await wire.requested
    XCTAssertEqual(requested, ["Solo."])
  }

  func testNothingIsPreparedOnceDegraded() async throws {
    await wire.fail("One.", with: .offline)
    let speaker = makeSpeaker()
    await speaker.speak("One.")
    speaker.prepare("Two.")
    try await Task.sleep(for: .milliseconds(30))
    let requested = await wire.requested
    XCTAssertEqual(requested, ["One."])
  }

  private func waitFor(_ condition: @escaping () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Condition not met within 3s")
  }
}
