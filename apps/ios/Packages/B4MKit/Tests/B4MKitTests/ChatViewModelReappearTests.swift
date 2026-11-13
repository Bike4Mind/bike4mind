import XCTest

@testable import B4MKit

/// A screen that went away stopped polling; coming back must not leave a turn stuck on "working".
@MainActor
final class ChatViewModelReappearTests: XCTestCase {
  private var api: FakeAPI!

  override func setUp() async throws {
    api = FakeAPI()
  }

  private func makeModel() -> ChatViewModel {
    ChatViewModel(
      sessionID: "s1", api: api, realtime: nil, sleep: { _ in try await Task.sleep(for: .milliseconds(1)) })
  }

  private func running() -> QuestTurn {
    QuestTurn(id: "quest-1", prompt: nil, reply: "", status: .running, createdAt: Samples.date)
  }

  func testReappearingResumesPollingForTurnsStillInFlight() async throws {
    await api.setPolledQuests([running()])
    let model = makeModel()
    await model.load()
    model.draft = "Hello"
    await model.send()
    let api = self.api!
    await eventually { await api.questLookups.count >= 1 }
    model.stop()

    await api.setPolledQuests([
      QuestTurn(id: "quest-1", prompt: nil, reply: "Done", status: .done, createdAt: Samples.date)
    ])
    await model.load()

    await eventually { await MainActor.run { model.turns.last?.status == .done } }
    model.stop()
  }

  func testATranscriptThatFinishedTheTurnReplacesTheStuckLiveCopy() async throws {
    await api.setPolledQuests([running()])
    let model = makeModel()
    model.draft = "Hello"
    await model.send()
    model.stop()
    XCTAssertFalse(model.liveTurns.first?.status?.isTerminal ?? true, "polling stopped before the turn settled")

    await api.setQuestPages([
      nil: Page(items: [Samples.quest("quest-1", prompt: "Hello", reply: "Hi", status: .done)], nextCursor: nil)
    ])
    await model.refresh()

    XCTAssertTrue(model.liveTurns.isEmpty)
    XCTAssertEqual(model.turns.map(\.status), [.done])
  }
}
