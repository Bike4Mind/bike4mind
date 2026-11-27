import XCTest

@testable import B4MKit

@MainActor
final class AccessibilityLabelTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  func testAUserBubbleReadsSpeakerTextAndTime() {
    let message = TranscriptMessage(
      id: "a", questID: "q", role: .user, text: "Plan a trip", createdAt: now.addingTimeInterval(-7_200))
    XCTAssertEqual(message.accessibilityLabel(now: now), "You: Plan a trip, 2 hours ago")
  }

  func testAnAssistantBubbleIncludesStatusAndCredits() {
    let message = TranscriptMessage(
      id: "a", questID: "q", role: .assistant, text: "Here you go", createdAt: now, status: .running, creditsUsed: 42)
    let label = message.accessibilityLabel(now: now)
    XCTAssertTrue(label.hasPrefix("Bike4Mind: Here you go, Working, "), label)
    XCTAssertTrue(label.hasSuffix("42 credits"), label)
  }

  func testAnEmptyWorkingBubbleStillSaysWhoAndWhy() {
    let message = TranscriptMessage(
      id: "a", questID: "q", role: .assistant, text: "", createdAt: now, status: .pending)
    XCTAssertEqual(message.accessibilityLabel(now: now), "Bike4Mind, Queued, Just now")
  }

  func testAPendingApprovalNamesTheTool() {
    let action = PendingAction(tool: "web_browse", parameters: [:], requestedAt: now)
    let message = TranscriptMessage(
      id: "a", questID: "q", role: .assistant, text: "", createdAt: now, status: .pending, pendingAction: action)
    XCTAssertTrue(message.accessibilityLabel(now: now).contains("Waiting for approval to run web_browse"))
  }

  func testEveryBadgeHasATitle() {
    let badges: [TranscriptMessage.Badge] = [
      .queued, .working, .stopped, .failed, .awaitingApproval, .outOfCredits(nil), .outOfCredits(.spendCapExceeded),
    ]
    for badge in badges { XCTAssertFalse(badge.title.isEmpty) }
    XCTAssertEqual(TranscriptMessage.Badge.outOfCredits(.spendCapExceeded).title, "Spend cap reached")
  }
}
