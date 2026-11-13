import XCTest

@testable import B4MKit

@MainActor
final class VoiceConversationModelTests: XCTestCase {
  private let api = FakeAPI()
  private let realtime = FakeRealtime()
  private let listener = FakeSpeechListener()
  private let speaker = FakeSpeaker()
  private let audio = FakeVoiceAudioSession()

  private let longReply = "The capital of France is Paris. It has been the capital for a very long time. "

  private func makeModel(
    target: ChatSendRequest.Target = .session("s1"), silenceTimeout: Duration = .seconds(30),
    stallTimeout: Duration = .seconds(30),
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) -> VoiceConversationModel {
    VoiceConversationModel(
      target: target, api: api, realtime: realtime, listener: listener, speaker: speaker, audioSession: audio,
      silenceTimeout: silenceTimeout, stallTimeout: stallTimeout, sleep: sleep)
  }

  private func startedModel(
    target: ChatSendRequest.Target = .session("s1"), silenceTimeout: Duration = .seconds(30),
    stallTimeout: Duration = .seconds(30),
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) async -> VoiceConversationModel {
    let model = makeModel(
      target: target, silenceTimeout: silenceTimeout, stallTimeout: stallTimeout, sleep: sleep)
    await model.start()
    await until { await realtime.listenerCount == 1 }
    await until { await listener.startCount == 1 }
    return model
  }

  private func frame(
    _ questID: String = "quest-1", session: String = "s1", reply: String?, status: QuestTurn.Status,
    credits: Double? = nil
  ) -> RealtimeEvent {
    var quest: JSONObject = [
      "id": .string(questID), "sessionId": .string(session), "type": "message", "status": .string(status.rawValue),
    ]
    if let reply { quest["reply"] = .string(reply) }
    if let credits { quest["creditsUsed"] = .number(credits) }
    return .frame(
      ActionFrame(
        action: "streamed_chat_completion", payload: ["action": "streamed_chat_completion", "quest": .object(quest)]))
  }

  private func say(_ text: String) async {
    await listener.emit(text, isFinal: true)
  }

  private func until(
    file: StaticString = #filePath, line: UInt = #line, _ condition: @MainActor () async -> Bool
  ) async {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Condition not met within 3s", file: file, line: line)
  }

  // MARK: - The loop

  func testAFullTurnListensSendsStreamsSpeaksAndListensAgain() async throws {
    let model = await startedModel()
    XCTAssertEqual(model.phase, .listening)

    await say("What is the capital of France")
    await until { await api.sentMessages.count == 1 }
    let sent = await api.sentMessages
    XCTAssertEqual(sent, [ChatSendRequest(message: "What is the capital of France", target: .session("s1"))])
    XCTAssertEqual(model.phase, .sending)

    await realtime.emit(frame(reply: "The capital of France is Paris. It has been", status: .running))
    await until { await speaker.spoken.count == 1 }
    let spokenFirst = await speaker.spoken
    XCTAssertEqual(spokenFirst, ["The capital of France is Paris."])

    await realtime.emit(frame(reply: longReply, status: .done, credits: 3))
    await until { model.phase == .listening }
    let spoken = await speaker.spoken
    XCTAssertEqual(spoken, ["The capital of France is Paris.", "It has been the capital for a very long time."])
    XCTAssertEqual(model.exchanges.map(\.replyText), [longReply])
    XCTAssertEqual(model.exchanges.first?.creditsUsed, 3)
    await model.stop()
  }

  func testAFrameThatBeatsTheSendResponseIsNotLost() async throws {
    await api.holdSends()
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }

    await realtime.emit(frame(reply: longReply, status: .done))
    await api.releaseSends()

    await until { await speaker.spoken.count == 2 }
    await until { model.phase == .listening }
    await model.stop()
  }

  func testTheNextUtteranceStartsAFreshRecognizer() async throws {
    let model = await startedModel()
    await say("First question about Paris")
    await until { await listener.startCount == 2 }
    await model.stop()
  }

  func testFramesForOtherQuestsAreIgnored() async throws {
    let model = await startedModel()
    await say("Hello there my friend")
    await until { await api.sentMessages.count == 1 }
    await until { model.phase == .sending }
    await realtime.emit(frame("other", session: "s2", reply: longReply, status: .done))
    try await Task.sleep(for: .milliseconds(50))
    let spoken = await speaker.spoken
    XCTAssertEqual(spoken, [])
    await model.stop()
  }

  func testSilenceEndsTheUtterance() async throws {
    let model = await startedModel(silenceTimeout: .milliseconds(30))
    await listener.emit("Name two colors")
    XCTAssertEqual(model.liveTranscript, "")
    await until { await api.sentMessages.count == 1 }
    let sent = await api.sentMessages
    XCTAssertEqual(sent.first?.message, "Name two colors")
    await model.stop()
  }

  // MARK: - Barge-in

  func testTalkingOverTheReplyStopsItAndStartsTheNextUtterance() async throws {
    await speaker.setHolding(true)
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await realtime.emit(frame(reply: longReply, status: .running))
    await until { model.phase == .speaking }

    await listener.emit("wait stop that")
    await until { model.phase == .listening }
    let stops = await speaker.stopCount
    XCTAssertGreaterThanOrEqual(stops, 1)
    XCTAssertEqual(model.liveTranscript, "wait stop that")
    XCTAssertEqual(model.exchanges.first?.wasInterrupted, true)

    // The rest of the old reply is dropped, never spoken.
    await realtime.emit(frame(reply: longReply + "A third sentence that is long enough. ", status: .done))
    try await Task.sleep(for: .milliseconds(50))
    let spoken = await speaker.spoken
    XCTAssertEqual(spoken, ["The capital of France is Paris."])

    await api.setSendResult(.success(ChatSendReceipt(questID: "quest-2", sessionID: "s1")))
    await say("wait stop that please")
    await until { await api.sentMessages.count == 2 }
    await model.stop()
  }

  func testASingleStrayWordDoesNotInterrupt() async throws {
    await speaker.setHolding(true)
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await realtime.emit(frame(reply: longReply, status: .running))
    await until { model.phase == .speaking }

    await listener.emit("uh")
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(model.phase, .speaking)
    await speaker.finishCurrent()
    await model.stop()
  }

  func testTappingInterruptStopsTheReply() async throws {
    await speaker.setHolding(true)
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await realtime.emit(frame(reply: longReply, status: .running))
    await until { model.phase == .speaking }

    await model.interrupt()
    XCTAssertEqual(model.phase, .listening)
    let stops = await speaker.stopCount
    XCTAssertGreaterThanOrEqual(stops, 1)
    await model.stop()
  }

  // MARK: - Failures

  func testARefusedTurnIsSpokenAndListeningResumes() async throws {
    await api.setSendResult(
      .success(ChatSendReceipt(questID: "quest-1", sessionID: "s1", kind: .error, errorCode: .insufficientCredits)))
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await speaker.spoken.count == 1 }
    let spoken = await speaker.spoken
    XCTAssertEqual(spoken, ["You're out of credits."])
    await until { model.phase == .listening }
    XCTAssertEqual(model.notice, "You're out of credits.")
    await model.stop()
  }

  func testAFailedSendIsSpokenAndListeningResumes() async throws {
    await api.setSendResult(.failure(.rateLimited))
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await speaker.spoken.count == 1 }
    await until { model.phase == .listening }
    await model.stop()
  }

  func testAnApprovalWaitIsAnnouncedNotSpoken() async throws {
    let model = await startedModel()
    await say("Delete my files please")
    await until { await api.sentMessages.count == 1 }
    await until { model.phase == .sending }
    let pending: JSONObject = [
      "id": "quest-1", "sessionId": "s1", "type": "message", "status": "running",
      "pendingAction": .object(["tool": "delete", "params": .object([:]), "ts": .number(1_700_000_000_000)]),
    ]
    await realtime.emit(
      .frame(
        ActionFrame(
          action: "streamed_chat_completion",
          payload: ["action": "streamed_chat_completion", "quest": .object(pending)])))
    await until { await speaker.spoken.count == 1 }
    let spoken = await speaker.spoken
    XCTAssertEqual(spoken, ["That needs your approval on screen."])
    await model.stop()
  }

  func testAStalledReplyIsRecoveredByPollingTheQuest() async throws {
    await api.setPolledQuests([
      QuestTurn(id: "quest-1", prompt: "q", reply: longReply, status: .done, kind: .message, createdAt: Date())
    ])
    let model = await startedModel(stallTimeout: .milliseconds(20))
    await say("Tell me about Paris")
    await until { await speaker.spoken.count == 2 }
    await until { model.phase == .listening }
    await model.stop()
  }

  func testDeniedPermissionFails() async throws {
    await listener.setPermission(.denied)
    let model = makeModel()
    await model.start()
    XCTAssertEqual(model.phase, .failed(.permissionDenied))
    let activations = await audio.activations
    XCTAssertEqual(activations, 0)
  }

  func testUndeterminedPermissionIsRequested() async throws {
    await listener.setPermission(.undetermined, grantsOnRequest: true)
    let model = await startedModel()
    XCTAssertEqual(model.phase, .listening)
    await model.stop()
  }

  func testAnUnavailableAudioSessionFails() async throws {
    await audio.setFailsToActivate(true)
    let model = makeModel()
    await model.start()
    XCTAssertEqual(model.phase, .failed(.audioSessionUnavailable))
  }

  // MARK: - New conversation

  func testANewConversationAdoptsTheSessionFromTheFirstReceipt() async throws {
    await api.setSendResult(.success(ChatSendReceipt(questID: "quest-1", sessionID: "fresh")))
    let model = await startedModel(target: .newConversation)
    var started: [String] = []
    model.onSessionStarted = { started.append($0) }

    await say("Start something new for me")
    await until { await api.sentMessages.count == 1 }
    await until { model.sessionID == "fresh" }
    XCTAssertEqual(started, ["fresh"])

    await realtime.emit(frame(session: "fresh", reply: longReply, status: .done))
    await until { model.phase == .listening }
    await api.setSendResult(.success(ChatSendReceipt(questID: "quest-2", sessionID: "fresh")))
    await say("And a second question now")
    await until { await api.sentMessages.count == 2 }
    let sent = await api.sentMessages
    XCTAssertEqual(sent.last?.target, .session("fresh"))
    XCTAssertEqual(started, ["fresh"])
    await model.stop()
  }

  func testRestartingTheRecognizerDoesNotCancelTheInFlightSend() async throws {
    await api.holdSends()
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await until { await listener.startCount == 2 }

    await api.releaseSends()
    await realtime.emit(frame(reply: longReply, status: .done))
    await until { model.phase == .listening && model.exchanges.last?.replyText.isEmpty == false }
    XCTAssertNil(model.notice)
    await model.stop()
  }

  // MARK: - Audio session

  func testACallPausesAndResumesWhenItEnds() async throws {
    await speaker.setHolding(true)
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await realtime.emit(frame(reply: longReply, status: .running))
    await until { model.phase == .speaking }

    await audio.emit(.interruptionBegan)
    await until { model.phase == .paused(.interrupted) }
    let stops = await speaker.stopCount
    XCTAssertGreaterThanOrEqual(stops, 1)

    await audio.emit(.interruptionEnded(shouldResume: true))
    await until { model.phase == .listening }
    let activations = await audio.activations
    XCTAssertEqual(activations, 2)
    await model.stop()
  }

  func testLosingHeadphonesPausesUntilTheUserResumes() async throws {
    let model = await startedModel()
    await audio.emit(.outputRouteLost)
    await until { model.phase == .paused(.outputLost) }

    await audio.emit(.interruptionEnded(shouldResume: true))
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(model.phase, .paused(.outputLost))

    await model.resume()
    XCTAssertEqual(model.phase, .listening)
    await model.stop()
  }

  func testStopReleasesEverything() async throws {
    let model = await startedModel()
    await model.stop()
    XCTAssertEqual(model.phase, .idle)
    let deactivations = await audio.deactivations
    XCTAssertEqual(deactivations, 1)
  }

  func testMutingStopsTheRecognizerAndUnmutingRestartsIt() async throws {
    let model = await startedModel()
    await model.setMuted(true)
    XCTAssertTrue(model.isMuted)
    await model.setMuted(false)
    let starts = await listener.startCount
    XCTAssertEqual(starts, 2)
    await model.stop()
  }

  func testARecognizerThatEndsOnItsOwnIsRestarted() async throws {
    let model = await startedModel()
    await listener.endTask()
    await until { await listener.startCount == 2 }
    XCTAssertEqual(model.phase, .listening)
    await model.stop()
  }

  // MARK: - Failure teardown

  func testASignedOutSendReleasesTheMicAndAudioSession() async throws {
    await api.setSendResult(.failure(.signedOut))
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { model.phase == .failed(.signedOut) }
    let deactivations = await audio.deactivations
    XCTAssertEqual(deactivations, 1)
    await until { await realtime.listenerCount == 0 }

    // Trying again leaves exactly one realtime subscriber.
    await api.setSendResult(.success(ChatSendReceipt(questID: "quest-1", sessionID: "s1")))
    await model.start()
    XCTAssertEqual(model.phase, .listening)
    await until { await realtime.listenerCount == 1 }
    await model.stop()
  }

  func testARecognizerThatCannotStartFailsAndReleasesTheAudioSession() async throws {
    await listener.setFailsToStart(true)
    let model = makeModel()
    await model.start()
    XCTAssertEqual(model.phase, .failed(.recognizerUnavailable))
    let deactivations = await audio.deactivations
    XCTAssertEqual(deactivations, 1)
  }

  func testARecognizerThatKeepsEndingWithoutSpeechFails() async throws {
    let model = await startedModel()
    for expected in 2...4 {
      await listener.endTask()
      await until { await listener.startCount == expected }
    }
    await listener.endTask()
    await until { model.phase == .failed(.recognizerUnavailable) }
    let deactivations = await audio.deactivations
    XCTAssertEqual(deactivations, 1)
  }

  func testResumeFailsWhenTheAudioSessionCannotBeRetaken() async throws {
    let model = await startedModel()
    await audio.emit(.outputRouteLost)
    await until { model.phase == .paused(.outputLost) }
    await audio.setFailsToActivate(true)
    await model.resume()
    XCTAssertEqual(model.phase, .failed(.audioSessionUnavailable))
  }

  func testStoppingMidSendDropsTheReplyAndStaysIdle() async throws {
    await api.holdSends()
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await model.stop()
    await api.releaseSends()
    await realtime.emit(frame(reply: longReply, status: .done))
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(model.phase, .idle)
    let spoken = await speaker.spoken
    XCTAssertEqual(spoken, [])
  }

  func testAnErrorFrameMidStreamIsSpokenAndListeningResumes() async throws {
    let model = await startedModel()
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await until { model.phase == .sending }
    let quest: JSONObject = [
      "id": "quest-1", "sessionId": "s1", "type": "error", "status": "error", "reply": "The model hit a problem.",
    ]
    await realtime.emit(
      .frame(
        ActionFrame(
          action: "streamed_chat_completion", payload: ["action": "streamed_chat_completion", "quest": .object(quest)])))
    await until { await speaker.spoken == ["The model hit a problem."] }
    await until { model.phase == .listening }
    await model.stop()
  }

  // MARK: - Stall watchdog

  func testAReplyThatNeverArrivesGivesUpAfterRepeatedStalls() async throws {
    let model = await startedModel(stallTimeout: .milliseconds(5))
    await say("Tell me about Paris")
    await until { await speaker.spoken == ["That took too long. Please try again."] }
    await until { model.phase == .listening }
    await model.stop()
  }

  func testAReplyThatKeepsStreamingIsNotCutOffByTheWatchdog() async throws {
    let model = await startedModel(sleep: { _ in try await Task.sleep(for: .milliseconds(15)) })
    await say("Tell me about Paris")
    await until { await api.sentMessages.count == 1 }
    await until { model.phase == .sending }

    // Far more intervals than the watchdog tolerates, each one with progress.
    var reply = ""
    for index in 0..<30 {
      reply += "Sentence number \(index) is long enough to be spoken. "
      await realtime.emit(frame(reply: reply, status: .running))
      try await Task.sleep(for: .milliseconds(8))
    }
    await realtime.emit(frame(reply: reply, status: .done))
    await until { model.phase == .listening }
    let spoken = await speaker.spoken
    XCTAssertFalse(spoken.contains("That took too long. Please try again."))
    XCTAssertEqual(spoken.count, 30)
    await model.stop()
  }

  // MARK: - Phase guards

  func testUnmutingWhileFailedDoesNotRestartTheMic() async throws {
    await listener.setPermission(.denied)
    let model = makeModel()
    await model.start()
    await model.setMuted(true)
    await model.setMuted(false)
    let starts = await listener.startCount
    XCTAssertEqual(starts, 0)
  }
}
