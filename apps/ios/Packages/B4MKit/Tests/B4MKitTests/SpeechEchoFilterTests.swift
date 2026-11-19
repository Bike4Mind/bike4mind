import XCTest

@testable import B4MKit

final class SpeechEchoFilterTests: XCTestCase {
  private let spoken = ["The capital of France is Paris.", "It has been the capital for a very long time."]

  private func residual(_ recognized: String, spoken: [String]? = nil) -> String {
    SpeechEchoFilter.residual(recognized: recognized, spoken: spoken ?? self.spoken, gapTolerance: 2)
  }

  func testAnExactEchoLeavesNothing() {
    XCTAssertEqual(residual("the capital of France is Paris"), "")
    XCTAssertEqual(residual("The capital of France is Paris it has been"), "")
  }

  func testWordsAfterTheEchoAreTheUser() {
    XCTAssertEqual(residual("the capital of France is Paris what about Rome"), "what about Rome")
  }

  func testAMisheardOrDroppedWordStaysInTheEcho() {
    XCTAssertEqual(residual("the capitol of France Paris"), "")
    XCTAssertEqual(residual("the capital of France is Paris it has bean the capital wait stop"), "wait stop")
  }

  func testTheRecognizerCanStartMidReply() {
    XCTAssertEqual(residual("been the capital for a very long time hold on"), "hold on")
  }

  func testAStrayWordBeforeTheEchoDoesNotHideIt() {
    XCTAssertEqual(residual("um the capital of France is Paris"), "")
    XCTAssertEqual(residual("a capital of France is Paris what about Rome"), "what about Rome")
    XCTAssertEqual(residual("so so the capital of France is Paris"), "so so the capital of France is Paris")
  }

  func testAStrayWordNeedsMoreThanOneEchoedWordAfterIt() {
    XCTAssertEqual(residual("wait Paris"), "wait Paris")
    XCTAssertEqual(residual("so time what about Rome"), "so time what about Rome")
  }

  func testTheReplysLastWordAloneIsEcho() {
    XCTAssertEqual(residual("time what about Rome"), "what about Rome")
    XCTAssertEqual(residual("Paris what about Rome", spoken: ["The capital of France is Paris."]), "what about Rome")
  }

  func testSpeechThatIsNotTheReplyIsKept() {
    XCTAssertEqual(residual("wait stop that"), "wait stop that")
    XCTAssertEqual(residual("the weather today"), "the weather today")
  }

  func testEmptyInputs() {
    XCTAssertEqual(residual("", spoken: spoken), "")
    XCTAssertEqual(residual("hello there", spoken: []), "hello there")
    XCTAssertEqual(residual("hello there", spoken: ["", "  "]), "hello there")
  }

  func testRepeatingTheReplyAfterABreakIsStillTheUser() {
    XCTAssertEqual(
      residual("the capital of France is Paris what about the capital of Italy"), "what about the capital of Italy")
    XCTAssertEqual(residual("Paris what about it"), "Paris what about it")
  }
}
