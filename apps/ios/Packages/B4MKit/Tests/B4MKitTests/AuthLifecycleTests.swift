import XCTest

@testable import B4MKit

final class AuthLifecycleTests: XCTestCase {
  func testRestoredLaunchStartsTheSessionAndRunsLaunchWork() {
    var lifecycle = AuthLifecycle()
    let plan = lifecycle.transition(to: .signedIn)
    XCTAssertEqual(
      plan, AuthLifecycle.Plan(startsSession: true, runsLaunchWork: true, releasesPendingRoute: true))
  }

  func testUnlockReleasesThePendingRouteButDoesNotRedoLaunchWork() {
    var lifecycle = AuthLifecycle()
    _ = lifecycle.transition(to: .signedIn)
    XCTAssertEqual(lifecycle.transition(to: .locked), AuthLifecycle.Plan())

    let unlock = lifecycle.transition(to: .signedIn)
    XCTAssertFalse(unlock.runsLaunchWork, "an unlock must not clear a running agent from the widget")
    XCTAssertFalse(unlock.startsSession)
    XCTAssertTrue(unlock.releasesPendingRoute, "a link tapped while locked opens once unlocked")
  }

  func testLaunchIntoAppLockRunsLaunchWorkOnTheFirstUnlockOnly() {
    var lifecycle = AuthLifecycle()
    let locked = lifecycle.transition(to: .locked)
    XCTAssertTrue(locked.startsSession)
    XCTAssertFalse(locked.runsLaunchWork, "nothing on screen to prepare while locked")

    XCTAssertTrue(lifecycle.transition(to: .signedIn).runsLaunchWork)
    _ = lifecycle.transition(to: .locked)
    XCTAssertFalse(lifecycle.transition(to: .signedIn).runsLaunchWork)
  }

  func testSignOutEndsTheSessionAndTheNextSignInStartsFresh() {
    var lifecycle = AuthLifecycle()
    _ = lifecycle.transition(to: .signedIn)
    XCTAssertEqual(lifecycle.transition(to: .signedOut(.userInitiated)), AuthLifecycle.Plan(endsSession: true))

    let signIn = lifecycle.transition(to: .signedIn)
    XCTAssertTrue(signIn.startsSession)
    XCTAssertTrue(signIn.runsLaunchWork)
  }
}
