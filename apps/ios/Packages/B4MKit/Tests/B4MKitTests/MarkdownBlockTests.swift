import XCTest

@testable import B4MKit

final class MarkdownBlockTests: XCTestCase {
  func testProseOnlyStaysOneBlock() {
    XCTAssertEqual(MarkdownBlock.split("Hello\n\nworld"), [.prose("Hello\n\nworld")])
  }

  func testFencedCodeSplitsOutWithItsLanguage() {
    let source = "Try this:\n\n```swift\nlet x = 1\n\nprint(x)\n```\nDone."
    XCTAssertEqual(
      MarkdownBlock.split(source),
      [.prose("Try this:"), .code(language: "swift", code: "let x = 1\n\nprint(x)"), .prose("Done.")])
  }

  func testAFenceWithoutLanguageHasNone() {
    XCTAssertEqual(MarkdownBlock.split("~~~\nplain\n~~~"), [.code(language: nil, code: "plain")])
  }

  func testAnUnclosedFenceRunsToTheEnd() {
    XCTAssertEqual(
      MarkdownBlock.split("Streaming\n```ts\nconst a"),
      [.prose("Streaming"), .code(language: "ts", code: "const a")])
  }

  func testAShorterFenceDoesNotCloseALongerOne() {
    XCTAssertEqual(
      MarkdownBlock.split("````md\n```\ninner\n```\n````"),
      [.code(language: "md", code: "```\ninner\n```")])
  }
}
