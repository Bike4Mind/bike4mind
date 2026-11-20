import XCTest

@testable import B4MKit

final class QuestActivityManagerTests: XCTestCase {
  private var host: FakeLiveActivityHost!
  private var pushAPI: FakePushTokenAPI!
  private var clock: TestClock!
  private var manager: QuestActivityManager!

  override func setUp() async throws {
    host = FakeLiveActivityHost()
    pushAPI = FakePushTokenAPI()
    clock = TestClock()
    manager = makeManager()
  }

  private func makeManager(policy: QuestActivityManager.Policy = QuestActivityManager.Policy()) -> QuestActivityManager
  {
    let api = pushAPI!
    let clock = clock!
    return QuestActivityManager(
      host: host, makeTokenAPI: { api }, environment: .sandbox, appVersion: "9.9", policy: policy,
      now: { clock.now }, sleep: { _ in })
  }

  private func start(_ id: String = "q1", state: QuestActivityContentState = QuestActivityContentState(phase: .running))
  {
    manager.questStarted(
      QuestActivityStart(
        questID: id, sessionID: "s1", title: "Trip planning", startedAt: clock.now, initialState: state))
  }

  private func activate() async {
    manager.sessionDidStart()
    await manager.waitUntilIdle()
  }

  // MARK: - Starting

  func testStartsOneActivityPerQuestOnceTheSessionIsActive() async {
    await activate()
    start()
    start()
    await manager.waitUntilIdle()

    let handles = host.handles
    XCTAssertEqual(handles.count, 1)
    XCTAssertEqual(handles.first?.attributes.questId, "q1")
    XCTAssertEqual(handles.first?.attributes.sessionId, "s1")
    XCTAssertEqual(handles.first?.attributes.title, "Trip planning")
    let ids = await manager.activeQuestIDs
    XCTAssertEqual(ids, ["q1"])
  }

  func testNothingStartsBeforeASessionIsActive() async {
    start()
    await manager.waitUntilIdle()
    XCTAssertTrue(host.handles.isEmpty)
  }

  func testDisabledActivitiesNoOpCleanly() async {
    host.setEnabled(false)
    await activate()
    start()
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .completed))
    await manager.waitUntilIdle()
    XCTAssertTrue(host.handles.isEmpty)
    let ids = await manager.activeQuestIDs
    XCTAssertTrue(ids.isEmpty)
  }

  func testAFailedStartLeavesNothingTracked() async {
    host.failStarts()
    await activate()
    start()
    await manager.waitUntilIdle()
    let ids = await manager.activeQuestIDs
    XCTAssertTrue(ids.isEmpty)
  }

  func testAQuestThatIsAlreadyFinishedDoesNotStartAnActivity() async {
    await activate()
    start(state: QuestActivityContentState(phase: .completed))
    await manager.waitUntilIdle()
    XCTAssertTrue(host.handles.isEmpty)
  }

  // MARK: - Local updates

  func testLocalUpdatesReachTheActivityWithAStaleDate() async throws {
    await activate()
    start()
    manager.questChanged(
      questID: "q1", to: QuestActivityContentState(phase: .running, stageLabel: "Searching your notes"))
    await manager.waitUntilIdle()

    let update = try XCTUnwrap(host.handles.first?.updates.first)
    XCTAssertEqual(update.state.stageLabel, "Searching your notes")
    XCTAssertEqual(update.staleDate, clock.now.addingTimeInterval(15 * 60))
  }

  func testIdenticalStatesAndRapidSamePhaseUpdatesAreDropped() async {
    await activate()
    start()
    let searching = QuestActivityContentState(phase: .running, stageLabel: "Searching")
    manager.questChanged(questID: "q1", to: searching)
    manager.questChanged(questID: "q1", to: searching)
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .running, stageLabel: "Reading"))
    await manager.waitUntilIdle()
    XCTAssertEqual(host.handles.first?.updates.count, 1, "the second label came inside the minimum interval")

    clock.advance(by: 2)
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .running, stageLabel: "Reading"))
    await manager.waitUntilIdle()
    XCTAssertEqual(host.handles.first?.updates.map(\.state.stageLabel), ["Searching", "Reading"])
  }

  func testAPhaseChangeIsNeverThrottled() async {
    await activate()
    start()
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .running, stageLabel: "Searching"))
    manager.questChanged(
      questID: "q1", to: QuestActivityContentState(phase: .approvalNeeded, stageLabel: "Waiting for your approval"))
    await manager.waitUntilIdle()
    XCTAssertEqual(host.handles.first?.updates.map(\.state.phase), [.running, .approvalNeeded])
  }

  func testARunningFrameWithoutALabelKeepsTheStageAlreadyShown() async {
    await activate()
    start()
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .running, stageLabel: "Searching"))
    await manager.waitUntilIdle()
    clock.advance(by: 5)
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .running, progress: 0.3))
    await manager.waitUntilIdle()
    let last = host.handles.first?.updates.last?.state
    XCTAssertEqual(last?.stageLabel, "Searching")
    XCTAssertEqual(last?.progress, 0.3)
  }

  func testUpdatesForAnUnknownQuestAreIgnored() async {
    await activate()
    manager.questChanged(questID: "ghost", to: QuestActivityContentState(phase: .running, stageLabel: "x"))
    await manager.waitUntilIdle()
    XCTAssertTrue(host.handles.isEmpty)
  }

  // MARK: - Ending

  func testATerminalStateEndsTheActivityAndLetsItLingerPerPolicy() async throws {
    let cases: [(QuestActivityContentState, TimeInterval)] = [
      (QuestActivityContentState(phase: .completed), 300),
      (QuestActivityContentState(phase: .stopped), 300),
      (QuestActivityContentState(phase: .failed, errored: true), 900),
    ]
    for (index, (state, linger)) in cases.enumerated() {
      let id = "q\(index)"
      await activate()
      start(id)
      manager.questChanged(questID: id, to: state)
      await manager.waitUntilIdle()
      let end = try XCTUnwrap(host.handles[index].ends.first)
      XCTAssertEqual(end.state, state)
      XCTAssertEqual(end.dismissal, .after(clock.now.addingTimeInterval(linger)), "\(state.phase)")
    }
    let ids = await manager.activeQuestIDs
    XCTAssertTrue(ids.isEmpty)
  }

  func testAFinishedQuestIsFinalAndCannotBeRestarted() async {
    await activate()
    start()
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .completed))
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .completed))
    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .running, stageLabel: "late frame"))
    start()
    await manager.waitUntilIdle()

    let handles = host.handles
    XCTAssertEqual(handles.count, 1, "no second activity for the same quest")
    XCTAssertEqual(handles[0].ends.count, 1, "ended exactly once")
    XCTAssertTrue(handles[0].updates.isEmpty)
  }

  func testWhenTheSystemEndsAnActivityFirstTheManagerLetsGo() async {
    await activate()
    start()
    await manager.waitUntilIdle()
    host.handles[0].emitLifecycle(.ended)
    await waitUntil("the manager to drop the activity") { [manager] in await manager!.activeQuestIDs.isEmpty }

    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .completed))
    await manager.waitUntilIdle()
    XCTAssertTrue(host.handles[0].ends.isEmpty, "a local end after a remote one has nothing left to end")
    XCTAssertTrue(host.handles[0].updates.isEmpty)
  }

  func testADismissedActivityFreesItsSlot() async {
    var policy = QuestActivityManager.Policy()
    policy.maxConcurrent = 1
    manager = makeManager(policy: policy)
    await activate()
    start("q1")
    await manager.waitUntilIdle()
    host.handles[0].emitLifecycle(.dismissed)
    await waitUntil("the slot to free") { [manager] in await manager!.activeQuestIDs.isEmpty }

    start("q2")
    await manager.waitUntilIdle()
    XCTAssertEqual(host.handles.count, 2)
    XCTAssertTrue(host.handles[0].ends.isEmpty, "nothing to evict")
  }

  // MARK: - Cap

  func testTheNewestQuestWinsBeyondTheCap() async {
    await activate()
    for index in 1...6 { start("q\(index)") }
    await manager.waitUntilIdle()

    let ids = await manager.activeQuestIDs
    XCTAssertEqual(ids, ["q2", "q3", "q4", "q5", "q6"])
    let handles = host.handles
    XCTAssertEqual(handles.count, 6)
    XCTAssertEqual(handles[0].ends.first?.dismissal, .immediate, "the oldest leaves the lock screen at once")
    XCTAssertTrue(handles[1].ends.isEmpty)
  }

  // MARK: - Session

  func testSigningOutEndsEverythingAndUnregistersTokens() async {
    host.issueTokenOnStart([0xAB, 0xCD])
    await activate()
    start("q1")
    start("q2")
    await waitUntil("both tokens registered") { [pushAPI] in await pushAPI!.liveActivityRegistrations.count == 2 }
    await waitUntil("both tokens recorded by the manager") { [manager] in
      await manager!.waitUntilIdle()
      return true
    }

    await manager.sessionWillEnd()

    for handle in host.handles { XCTAssertEqual(handle.ends.first?.dismissal, .immediate) }
    let unregistered = await pushAPI.unregistered
    XCTAssertEqual(unregistered, ["abcd", "abcd"])
    let ids = await manager.activeQuestIDs
    XCTAssertTrue(ids.isEmpty)

    start("q3")
    await manager.waitUntilIdle()
    XCTAssertEqual(host.handles.count, 2, "a signed-out app starts no activities")
  }

  func testASessionThatEndedByItselfEndsActivitiesWithoutCallingTheServer() async {
    host.issueTokenOnStart([0x01])
    await activate()
    start()
    await waitUntil("registration") { [pushAPI] in await pushAPI!.liveActivityRegistrations.count == 1 }

    manager.sessionDidEnd()
    await manager.waitUntilIdle()

    XCTAssertEqual(host.handles[0].ends.first?.dismissal, .immediate)
    let unregistered = await pushAPI.unregistered
    XCTAssertTrue(unregistered.isEmpty)
  }

  func testSurvivingActivitiesAreAdoptedAndEndedOnSignOut() async {
    let survivor = host.addSurvivor(questID: "old-quest")
    await activate()
    let ids = await manager.activeQuestIDs
    XCTAssertEqual(ids, ["old-quest"])

    start("old-quest")
    await manager.waitUntilIdle()
    XCTAssertEqual(host.handles.count, 0, "an adopted quest does not get a second activity")

    survivor.emitToken([0x0F])
    await waitUntil("the survivor's token to be registered") { [pushAPI] in
      await pushAPI!.liveActivityRegistrations.map(\.questID) == ["old-quest"]
    }

    await manager.sessionWillEnd()
    XCTAssertEqual(survivor.ends.first?.dismissal, .immediate)
  }

  // MARK: - Push token registration

  func testTheActivityTokenIsRegisteredWithTheContractFields() async {
    host.issueTokenOnStart([0xDE, 0xAD, 0xBE, 0xEF])
    await activate()
    start("quest-77")
    await waitUntil("registration") { [pushAPI] in await pushAPI!.liveActivityRegistrations.count == 1 }

    let registration = await pushAPI.liveActivityRegistrations.first
    XCTAssertEqual(
      registration,
      FakePushTokenAPI.LiveActivityRegistration(
        token: "deadbeef", activityID: host.handles[0].activityID, questID: "quest-77", environment: .sandbox))
  }

  func testARotatedTokenIsRegisteredAgain() async {
    host.issueTokenOnStart([0x01])
    await activate()
    start()
    await waitUntil("first token") { [pushAPI] in await pushAPI!.liveActivityRegistrations.count == 1 }
    host.handles[0].emitToken([0x02])
    await waitUntil("rotated token") { [pushAPI] in
      await pushAPI!.liveActivityRegistrations.map(\.token) == ["01", "02"]
    }
  }

  func testRegistrationRetriesWhileTheServerIsUnreachable() async {
    await pushAPI.failLiveActivityRegistrations(2)
    host.issueTokenOnStart([0x0A])
    await activate()
    start()
    await waitUntil("registration after retries") { [pushAPI] in await pushAPI!.liveActivityRegistrations.count == 1 }
    let attempts = await pushAPI.liveActivityAttempts
    XCTAssertEqual(attempts, 3)
  }

  func testRegistrationGivesUpAfterTheRetryBudget() async {
    await pushAPI.failLiveActivityRegistrations(100)
    host.issueTokenOnStart([0x0A])
    await activate()
    start()
    await waitUntil("all attempts used") { [pushAPI] in await pushAPI!.liveActivityAttempts == 4 }
    try? await Task.sleep(for: .milliseconds(50))
    let attempts = await pushAPI.liveActivityAttempts
    XCTAssertEqual(attempts, 4, "one try plus three retries")
  }

  func testARefusedRegistrationIsNotRetried() async {
    await pushAPI.failRegistration(with: APIError.forbidden)
    await pushAPI.failLiveActivityRegistrations(100)
    host.issueTokenOnStart([0x0A])
    await activate()
    start()
    await waitUntil("first attempt") { [pushAPI] in await pushAPI!.liveActivityAttempts >= 1 }
    try? await Task.sleep(for: .milliseconds(50))
    let attempts = await pushAPI.liveActivityAttempts
    XCTAssertEqual(attempts, 1)
  }

  func testEndingAnActivityUnregistersItsToken() async {
    host.issueTokenOnStart([0xCA, 0xFE])
    await activate()
    start()
    await waitUntil("registration") { [pushAPI] in await pushAPI!.liveActivityRegistrations.count == 1 }
    await manager.waitUntilIdle()

    manager.questChanged(questID: "q1", to: QuestActivityContentState(phase: .completed))
    await waitUntil("unregister") { [pushAPI] in await pushAPI!.unregistered == ["cafe"] }
  }
}
