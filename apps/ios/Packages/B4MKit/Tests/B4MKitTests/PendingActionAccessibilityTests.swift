import XCTest

@testable import B4MKit

@MainActor
final class PendingActionAccessibilityTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  private func label(for action: PendingAction) -> String {
    TranscriptMessage(
      id: "a", questID: "q", role: .assistant, text: "", createdAt: now, status: .pending, pendingAction: action
    ).accessibilityLabel(now: now)
  }

  func testAnOpenApprovalSaysWhereToAnswerAndWithWhat() {
    let text = label(
      for: PendingAction(
        tool: "web_browse", parameters: ["url": "https://example.com", "depth": "2"], requestedAt: now))
    XCTAssertTrue(text.contains("Approve or deny this on Bike4Mind for the web"), text)
    XCTAssertTrue(text.contains("depth: 2, url: https://example.com"), text)
  }

  func testALapsedApprovalSaysItExpired() {
    let requested = now.addingTimeInterval(-(PendingAction.lifetime + 60))
    let text = label(for: PendingAction(tool: "web_browse", parameters: [:], requestedAt: requested))
    XCTAssertTrue(text.contains("This request expired"), text)
    XCTAssertFalse(text.contains("Approve or deny"), text)
  }
}
