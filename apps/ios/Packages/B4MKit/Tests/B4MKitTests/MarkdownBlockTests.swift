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

  func testHeadingsSplitOutWithTheirLevel() {
    XCTAssertEqual(
      MarkdownBlock.split("# Title\nIntro\n### Deep *one* ##"),
      [.heading(level: 1, text: "Title"), .prose("Intro"), .heading(level: 3, text: "Deep *one*")])
  }

  func testAHashWithoutASpaceIsProse() {
    XCTAssertEqual(MarkdownBlock.split("#hashtag\n####### seven"), [.prose("#hashtag\n####### seven")])
  }

  func testBulletAndNumberedItemsSplitOut() {
    XCTAssertEqual(
      MarkdownBlock.split("Points:\n- one\n* two\n  + nested\n1. first\n12) twelfth"),
      [
        .prose("Points:"),
        .listItem(marker: .bullet, depth: 0, text: "one"),
        .listItem(marker: .bullet, depth: 0, text: "two"),
        .listItem(marker: .bullet, depth: 1, text: "nested"),
        .listItem(marker: .number("1."), depth: 0, text: "first"),
        .listItem(marker: .number("12)"), depth: 0, text: "twelfth"),
      ])
  }

  func testQuotesAndRulesSplitOut() {
    XCTAssertEqual(
      MarkdownBlock.split("> quoted\n>more\n\n---\nafter"),
      [.quote("quoted\nmore"), .rule, .prose("after")])
  }

  func testBlockSyntaxInsideAFenceStaysCode() {
    XCTAssertEqual(
      MarkdownBlock.split("```\n# not a heading\n- nor a list\n```"),
      [.code(language: nil, code: "# not a heading\n- nor a list")])
  }

  func testAStreamingHeadingWithoutTextYetStaysProse() {
    XCTAssertEqual(MarkdownBlock.split("Intro\n#"), [.prose("Intro\n#")])
  }
}
