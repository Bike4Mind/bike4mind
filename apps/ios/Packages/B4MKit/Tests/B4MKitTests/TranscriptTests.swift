import XCTest

@testable import B4MKit

final class TranscriptMapperTests: XCTestCase {
  func testOldestFirstOrderIsPreservedAsPromptThenReplyPerTurn() {
    let turns = [Samples.quest("a"), Samples.quest("b"), Samples.quest("c")]

    let messages = TranscriptMapper.messages(from: turns)

    XCTAssertEqual(
      messages.map(\.id), ["a.prompt", "a.reply", "b.prompt", "b.reply", "c.prompt", "c.reply"])
    XCTAssertEqual(messages.map(\.role), [.user, .assistant, .user, .assistant, .user, .assistant])
  }

  func testPendingActionIsSurfacedOnTheAssistantBubble() throws {
    let action = PendingAction(tool: "file_delete", parameters: ["path": "/x"], requestedAt: Samples.date)
    let turn = Samples.quest("q", reply: "", status: .pending, pendingAction: action)

    let reply = try XCTUnwrap(TranscriptMapper.messages(for: turn).last)

    XCTAssertEqual(reply.role, .assistant)
    XCTAssertEqual(reply.pendingAction, action)
    XCTAssertEqual(reply.badge, .awaitingApproval)
  }

  func testRunningTurnWithoutReplyStillGetsABubbleForItsBadge() throws {
    let turn = Samples.quest("q", reply: nil, status: .running)
    let messages = TranscriptMapper.messages(for: turn)
    XCTAssertEqual(messages.count, 2)
    XCTAssertEqual(messages.last?.badge, .working)
  }

  func testFinishedTurnHasNoBadge() throws {
    let reply = try XCTUnwrap(TranscriptMapper.messages(for: Samples.quest("q")).last)
    XCTAssertNil(reply.badge)
  }

  func testLegacyTurnWithoutStatusHasNoBadge() throws {
    let reply = try XCTUnwrap(TranscriptMapper.messages(for: Samples.quest("q", status: nil)).last)
    XCTAssertNil(reply.badge)
  }

  func testStoppedAndErrorTurnsAreBadged() throws {
    let stopped = try XCTUnwrap(TranscriptMapper.messages(for: Samples.quest("s", status: .stopped)).last)
    XCTAssertEqual(stopped.badge, .stopped)

    let failed = QuestTurn(
      id: "e", prompt: "p", reply: "no credits", status: .stopped, kind: .error, errorCode: .insufficientCredits,
      createdAt: Samples.date)
    let bubble = try XCTUnwrap(TranscriptMapper.messages(for: failed).last)
    XCTAssertEqual(bubble.badge, .outOfCredits(.insufficientCredits))
  }

  func testTurnWithoutPromptOrReplyProducesNothing() {
    XCTAssertTrue(TranscriptMapper.messages(for: Samples.quest("q", prompt: nil, reply: nil)).isEmpty)
  }

  func testPendingActionLapsesAfterFifteenMinutes() {
    let action = PendingAction(tool: "t", parameters: [:], requestedAt: Samples.date)
    XCTAssertFalse(action.hasLapsed(at: Samples.date.addingTimeInterval(14 * 60)))
    XCTAssertTrue(action.hasLapsed(at: Samples.date.addingTimeInterval(16 * 60)))
  }
}

@MainActor
final class TranscriptViewModelTests: XCTestCase {
  func testPagesAccumulateOldestFirstAcrossCursors() async {
    let api = FakeAPI()
    await api.setQuestPages([
      nil: Page(items: [Samples.quest("1"), Samples.quest("2")], nextCursor: "c2"),
      "c2": Page(items: [Samples.quest("3")], nextCursor: nil),
    ])
    let model = TranscriptViewModel(sessionID: "s", api: api, pageSize: 2)

    await model.load()
    XCTAssertTrue(model.hasMore)
    XCTAssertEqual(model.messages.count, 4)

    await model.loadMore()

    XCTAssertFalse(model.hasMore)
    XCTAssertEqual(
      model.messages.map(\.questID), ["1", "1", "2", "2", "3", "3"])
    let cursors = await api.questCursors
    XCTAssertEqual(cursors, [nil, "c2"])
  }

  func testLoadMoreIsANoOpOnceExhausted() async {
    let api = FakeAPI()
    await api.setQuestPages([nil: Page(items: [Samples.quest("1")], nextCursor: nil)])
    let model = TranscriptViewModel(sessionID: "s", api: api)
    await model.load()
    await model.loadMore()
    let cursors = await api.questCursors
    XCTAssertEqual(cursors.count, 1)
  }

  func testReachingTheLastMessagesLoadsTheNextPage() async throws {
    let api = FakeAPI()
    await api.setQuestPages([
      nil: Page(items: [Samples.quest("1")], nextCursor: "c2"),
      "c2": Page(items: [Samples.quest("2")], nextCursor: nil),
    ])
    let model = TranscriptViewModel(sessionID: "s", api: api)
    await model.load()

    await model.loadMoreIfNeeded(currentMessage: try XCTUnwrap(model.messages.last))

    XCTAssertEqual(model.messages.count, 4)
  }

  func testFailureOnFirstLoadIsReportedAndRetryable() async {
    let api = FakeAPI()
    await api.setFailure(.offline)
    let model = TranscriptViewModel(sessionID: "s", api: api)

    await model.load()
    XCTAssertEqual(model.state, .failed(.offline))

    await api.setFailure(nil)
    await api.setQuestPages([nil: Page(items: [Samples.quest("1")], nextCursor: nil)])
    await model.refresh()
    XCTAssertEqual(model.state, .loaded)
    XCTAssertEqual(model.messages.count, 2)
  }

  func testFailedLoadMoreKeepsTheLoadedMessages() async {
    let api = FakeAPI()
    await api.setQuestPages([nil: Page(items: [Samples.quest("1")], nextCursor: "c2")])
    let model = TranscriptViewModel(sessionID: "s", api: api)
    await model.load()

    await api.setFailure(.rateLimited)
    await model.loadMore()

    XCTAssertEqual(model.messages.count, 2)
    XCTAssertEqual(model.loadMoreError, .rateLimited)
    XCTAssertEqual(model.state, .loaded)
  }
}
