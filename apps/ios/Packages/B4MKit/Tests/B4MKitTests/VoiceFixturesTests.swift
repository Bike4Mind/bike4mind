import XCTest

@testable import B4MKit

@MainActor
final class VoiceFixturesTests: XCTestCase {
  func testScriptedLinesWaitForEachPromptToFinish() async throws {
    var heard: [String] = []
    let model = VoiceFixtures.makeModel(
      target: .newConversation, api: FakeAPI(), realtime: FakeRealtime(),
      bargeInWords: BriefVoiceSession.bargeInWords, opening: ["Approve or deny it?"],
      utteranceHandler: { text in
        heard.append(text)
        return text == "approve" ? "Approve it? Say yes to go ahead." : "Approved."
      },
      script: ["approve", "yes"], quietBeforeLine: .milliseconds(100))
    await model.start()

    let deadline = Date().addingTimeInterval(8)
    while heard.count < 2, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
    XCTAssertEqual(heard, ["approve", "yes"])
    XCTAssertEqual(model.exchanges.first?.wasInterrupted, false)
    await model.stop()
  }
}
