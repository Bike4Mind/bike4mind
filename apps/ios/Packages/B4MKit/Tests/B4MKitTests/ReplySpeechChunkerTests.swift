import XCTest

@testable import B4MKit

final class ReplySpeechChunkerTests: XCTestCase {
  func testASentenceIsReleasedOnlyOnceItsTerminatorIsFollowedByWhitespace() {
    var chunker = ReplySpeechChunker()
    XCTAssertEqual(chunker.ingest(cumulative: "The capital of France is Paris.", isFinal: false), [])
    XCTAssertEqual(
      chunker.ingest(cumulative: "The capital of France is Paris. It", isFinal: false),
      ["The capital of France is Paris."])
  }

  func testOnlyNewSentencesAreReturnedFromCumulativeText() {
    var chunker = ReplySpeechChunker()
    let first = "The first sentence is long enough. "
    let second = "The second sentence is long too. "
    XCTAssertEqual(chunker.ingest(cumulative: first, isFinal: false), ["The first sentence is long enough."])
    XCTAssertEqual(chunker.ingest(cumulative: first, isFinal: false), [])
    XCTAssertEqual(chunker.ingest(cumulative: first + second, isFinal: false), ["The second sentence is long too."])
  }

  func testTheFinalUpdateFlushesTheTail() {
    var chunker = ReplySpeechChunker()
    XCTAssertEqual(chunker.ingest(cumulative: "Short tail", isFinal: false), [])
    XCTAssertEqual(chunker.ingest(cumulative: "Short tail", isFinal: true), ["Short tail"])
    XCTAssertEqual(chunker.ingest(cumulative: "Short tail", isFinal: true), [])
  }

  func testShortSentencesMergeIntoTheNextOne() {
    var chunker = ReplySpeechChunker()
    let chunks = chunker.ingest(cumulative: "Yes. That works and here is exactly why. ", isFinal: false)
    XCTAssertEqual(chunks, ["Yes. That works and here is exactly why."])
  }

  func testDecimalsDoNotEndASentence() {
    var chunker = ReplySpeechChunker()
    let chunks = chunker.ingest(cumulative: "Pi is roughly 3.14159 which is irrational. Next", isFinal: false)
    XCTAssertEqual(chunks, ["Pi is roughly 3.14159 which is irrational."])
  }

  func testAnUnclosedCodeFenceHoldsBackUntilItCloses() {
    var chunker = ReplySpeechChunker()
    let open = "Here is the code you asked for:\n```swift\nlet value = 1\n"
    XCTAssertEqual(chunker.ingest(cumulative: open, isFinal: false), ["Here is the code you asked for:"])
    XCTAssertEqual(
      chunker.ingest(cumulative: open + "```\nThat is all of it, really.\n", isFinal: false),
      ["Code on screen. That is all of it, really."])
  }

  func testARewrittenReplyIsIgnoredUntilItIsStableAgain() {
    var chunker = ReplySpeechChunker()
    _ = chunker.ingest(cumulative: "The first sentence is long enough. ", isFinal: false)
    XCTAssertEqual(chunker.ingest(cumulative: "Something else entirely now. ", isFinal: false), [])
  }

  func testMarkdownIsCleanedForSpeech() {
    XCTAssertEqual(SpeechText.clean("## Title\n- **bold** and `code`"), "Title bold and code")
    XCTAssertEqual(SpeechText.clean("See [the docs](https://example.com/x) now"), "See the docs now")
    XCTAssertEqual(SpeechText.clean("Open https://example.com/long/path today"), "Open link today")
    XCTAssertEqual(SpeechText.clean("Before ```a\nb``` after"), "Before Code on screen. after")
  }
}
