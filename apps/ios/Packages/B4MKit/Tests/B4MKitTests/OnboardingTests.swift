import XCTest

@testable import B4MKit

final class OnboardingTests: XCTestCase {
  func testWelcomeIsShortAndEveryPageHasCopy() {
    XCTAssertTrue((2...3).contains(Onboarding.pages.count))
    for page in Onboarding.pages {
      XCTAssertFalse(page.title.isEmpty)
      XCTAssertFalse(page.message.isEmpty)
      XCTAssertFalse(page.systemImage.isEmpty)
    }
    XCTAssertEqual(Set(Onboarding.pages.map(\.id)).count, Onboarding.pages.count)
  }

  func testTheNotificationsPageComesBeforeSignIn() {
    XCTAssertEqual(Onboarding.pages.last?.id, "notifications")
  }

  func testShowsOnlyToAFreshSignedOutUser() {
    XCTAssertTrue(Onboarding.shouldShow(isCompleted: false, signOutReason: nil))
    XCTAssertFalse(Onboarding.shouldShow(isCompleted: true, signOutReason: nil))
    XCTAssertFalse(Onboarding.shouldShow(isCompleted: false, signOutReason: .userInitiated))
    XCTAssertFalse(Onboarding.shouldShow(isCompleted: false, signOutReason: .sessionEnded))
    XCTAssertFalse(Onboarding.shouldShow(isCompleted: false, signOutReason: .accountDeletionRequested))
  }
}
