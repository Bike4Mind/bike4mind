import XCTest

@testable import B4MKit

final class ReplyVisibilityTests: XCTestCase {
  private let choices = "```choices\n{\"options\":[{\"label\":\"A\",\"description\":\"a\"}]}\n```"

  func testPlainTextIsUnchanged() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("Hello **there**"), "Hello **there**")
  }

  func testAClosedChoicesBlockIsStripped() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("Pick one:\n\n\(choices)\n"), "Pick one:")
  }

  func testAChoicesBlockStillStreamingIsHiddenToTheEnd() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("Pick one:\n\n```choices\n{\"options\":[{\"lab"), "Pick one:")
  }

  func testProseAfterTheBlockIsKept() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("Pick one:\n\(choices)\n\nOr ask me."), "Pick one:\n\nOr ask me.")
  }

  func testOnlyTheLastChoicesBlockIsStripped() {
    XCTAssertEqual(
      ReplyVisibility.visibleSlot("One\n\(choices)\nTwo\n\(choices)"), "One\n\(choices)\nTwo")
  }

  func testAChoicesSampleInsideALongerFenceIsContent() {
    let reply = "Example:\n````md\n\(choices)\n````"
    XCTAssertEqual(ReplyVisibility.visibleSlot(reply), reply)
  }

  func testOtherFencesAreKept() {
    let reply = "Code:\n```swift\nlet a = 1\n```"
    XCTAssertEqual(ReplyVisibility.visibleSlot(reply), reply)
  }

  func testCRLFLineEndsAreFenceLines() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("Pick:\r\n```choices\r\n{}\r\n```\r\n\r\nOr ask."), "Pick:\n\nOr ask.")
  }

  func testThinkingIsHidden() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("<think>plan</think>Answer"), "Answer")
  }

  func testAnOpenThinkHidesTheRest() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("<think>still planning"), "")
  }

  func testAChoicesBlockDraftedWhileThinkingIsNotRead() {
    XCTAssertEqual(
      ReplyVisibility.visibleSlot("<think>\(choices)</think>Answer\n\(choices)"), "Answer")
  }

  func testAStrayCloseTagIsText() {
    XCTAssertEqual(ReplyVisibility.visibleSlot("a </think> b"), "a </think> b")
  }

  func testWhitespaceOnlyIsInvisible() {
    XCTAssertEqual(ReplyVisibility.visibleSlot(" \n "), "")
  }

  func testSlotsJoinAfterStripping() {
    XCTAssertEqual(
      ReplyVisibility.text(replies: ["<think>x</think>", "Hi.", " Pick:\n\(choices)"], reply: nil), "Hi. Pick:")
  }

  func testTheScalarIsTheFallback() {
    XCTAssertEqual(ReplyVisibility.text(replies: ["<think>x"], reply: "Saved"), "Saved")
    XCTAssertNil(ReplyVisibility.text(replies: [], reply: ""))
  }

  func testAFrameHidesTheChoicesBlock() {
    XCTAssertEqual(
      ChatQuestFrame.replyText(reply: nil, replies: .array([.string("Pick:\n```choices\n{")])), "Pick:")
  }
}
