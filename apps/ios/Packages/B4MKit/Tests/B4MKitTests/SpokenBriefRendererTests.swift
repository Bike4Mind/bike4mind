import XCTest

@testable import B4MKit

private func brief(
  status: BriefStatus = .ready, headline: String? = nil, happened: [String] = [], handled: [String] = [],
  decisions: [BriefDecision] = []
) -> Brief {
  let now = Date(timeIntervalSince1970: 1_700_000_000)
  return Brief(
    id: "b1", status: status, createdAt: now, periodStart: now, periodEnd: now, headline: headline,
    happened: happened.enumerated().map { BriefItem(id: "h\($0.offset)", text: $0.element) },
    handled: handled.enumerated().map { BriefItem(id: "d\($0.offset)", text: $0.element) },
    decisions: decisions)
}

private func approval(_ id: String, _ text: String, _ state: BriefApprovalState = .pending) -> BriefDecision {
  BriefDecision(
    id: id, text: text, approval: BriefApprovalRef(questID: "q", sessionID: "s", pendingActionTs: 1, state: state))
}

private func question(
  _ id: String, _ text: String, options: [String] = [], _ state: BriefQuestionState = .open
) -> BriefDecision {
  BriefDecision(
    id: id, text: text, question: BriefQuestionRef(questID: "q", sessionID: "s", options: options, state: state))
}

final class SpokenBriefRendererTests: XCTestCase {
  func testFullBriefSpeaksHeadlineHappenedHandledThenFirstPendingDecision() {
    let sections = SpokenBriefRenderer.sections(
      for: brief(
        headline: "A busy morning", happened: ["Deploy finished"], handled: ["Triaged 3 emails."],
        decisions: [approval("a0", "Old", .approved), approval("a1", "Ship the budget"), question("q1", "Which day")]))

    XCTAssertEqual(
      sections,
      [
        "A busy morning.",
        "Here's what happened. Deploy finished.",
        "Handled for you. Triaged 3 emails.",
        "2 things need you. Ship the budget. Approve or deny it?",
      ])
  }

  func testComposeShapedMarkdownLeavesNoMarkupInSpeech() {
    let sections = SpokenBriefRenderer.sections(
      for: brief(
        headline: "## **Three** agents ran overnight",
        happened: [
          "- **Research agent** finished the [market scan](https://example.com/report) for `Q3`",
          "* _Deploy_ of build_42 succeeded, see https://ci.example.com/runs/42",
          "1. Inbox > 12 new threads",
        ],
        handled: ["> Archived ~~4~~ stale drafts (https://example.com/drafts)"],
        decisions: [question("q1", "**Pick** a launch day", options: ["`Monday`", "[Tuesday](https://x.io)"])]))

    let spoken = sections.joined(separator: " ")
    for markup in ["*", "_", "`", "#", "[", "](", "http", "www.", "~", "()"] {
      XCTAssertFalse(spoken.contains(markup), "\(markup) reached speech: \(spoken)")
    }
    XCTAssertEqual(sections[0], "Three agents ran overnight.")
    XCTAssertTrue(sections[1].contains("Research agent finished the market scan for Q3."))
    XCTAssertTrue(sections[1].contains("Deploy of build 42 succeeded, see."))
    XCTAssertEqual(sections[3], "One thing needs you. Pick a launch day. Options: Monday or Tuesday.")
  }

  func testPlainDropsBareURLsAndCollapsesWhitespace() {
    XCTAssertEqual(SpokenBriefRenderer.plain("Read   this\n\nnow https://example.com/x ."), "Read this now.")
    XCTAssertEqual(SpokenBriefRenderer.plain("![chart](https://example.com/c.png) attached"), "chart attached")
  }

  func testItemsThatRenderEmptyAreSkipped() {
    let sections = SpokenBriefRenderer.sections(
      for: brief(headline: "", happened: ["https://example.com/only-a-link", "  "], handled: ["Filed a report"]))
    XCTAssertEqual(sections, ["Handled for you. Filed a report."])
  }

  func testEmptyHeadlineAndEmptyArraysSayNothingNeedsYou() {
    XCTAssertEqual(SpokenBriefRenderer.sections(for: brief()), ["Nothing new needs you right now."])
    XCTAssertEqual(
      SpokenBriefRenderer.sections(for: brief(headline: "**`  `**")), ["Nothing new needs you right now."])
  }

  func testAllDecisionsResolvedSpeaksNoDecisionSection() {
    let sections = SpokenBriefRenderer.sections(
      for: brief(
        headline: "Quiet day",
        decisions: [
          approval("a1", "Old", .denied), approval("a2", "Gone", .lapsed), question("q1", "Asked", .answered),
          question("q2", "Moved on", .superseded),
        ]))
    XCTAssertEqual(sections, ["Quiet day."])
  }

  func testOnlyResolvedDecisionsAndNoTextSaysNothingNeedsYou() {
    let sections = SpokenBriefRenderer.sections(for: brief(decisions: [approval("a1", "Done", .approved)]))
    XCTAssertEqual(sections, ["Nothing new needs you right now."])
  }

  func testQuestionPromptWithAndWithoutOptions() {
    XCTAssertEqual(
      SpokenBriefRenderer.prompt(for: question("q", "Which region?", options: ["east", "west", "both"])),
      "Which region? Options: east, west, or both.")
    XCTAssertEqual(
      SpokenBriefRenderer.prompt(for: question("q", "Which region", options: ["east"])),
      "Which region. Options: east.")
    XCTAssertEqual(
      SpokenBriefRenderer.prompt(for: question("q", "What should the title be")),
      "What should the title be. Say reply and your answer.")
    XCTAssertEqual(
      SpokenBriefRenderer.prompt(for: question("q", "Pick", options: ["https://example.com"])),
      "Pick. Say reply and your answer.")
  }

  func testPromptIsNilOnceTheDecisionCannotBeAnswered() {
    XCTAssertNil(SpokenBriefRenderer.prompt(for: approval("a", "x", .replaced)))
    XCTAssertNil(SpokenBriefRenderer.prompt(for: question("q", "x", .answered)))
    XCTAssertNil(SpokenBriefRenderer.prompt(for: BriefDecision(id: "d", text: "No ref")))
    XCTAssertEqual(SpokenBriefRenderer.prompt(for: approval("a", "")), "Approve or deny it?")
  }

  func testComposingFailedAndUnknownStatuses() {
    XCTAssertEqual(
      SpokenBriefRenderer.sections(for: brief(status: .composing, headline: "x")),
      ["Your brief is still being put together."])
    XCTAssertEqual(
      SpokenBriefRenderer.sections(for: brief(status: .unknown("queued"))), ["Your brief is still being put together."])
    XCTAssertEqual(
      SpokenBriefRenderer.sections(for: brief(status: .failed)), ["Your brief couldn't be put together."])
  }

  func testSectionCapsAtFiveItemsAndCountsTheRest() {
    let items = (1...8).map { "Item \($0)" }
    let sections = SpokenBriefRenderer.sections(for: brief(happened: items, handled: Array(items.prefix(5))))
    XCTAssertEqual(
      sections[0], "Here's what happened. Item 1. Item 2. Item 3. Item 4. Item 5. And 3 more.")
    XCTAssertEqual(sections[1], "Handled for you. Item 1. Item 2. Item 3. Item 4. Item 5.")
  }

  func testSinglePendingDecisionUsesSingularCount() {
    let sections = SpokenBriefRenderer.sections(for: brief(decisions: [question("q1", "Name it?")]))
    XCTAssertEqual(sections, ["One thing needs you. Name it? Say reply and your answer."])
  }
}
