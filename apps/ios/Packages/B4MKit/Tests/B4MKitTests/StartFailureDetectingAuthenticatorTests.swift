import XCTest

@testable import B4MKit

@MainActor
final class StartFailureDetectingAuthenticatorTests: XCTestCase {
  private let authorizeURL = URL(string: "https://app.bike4mind.com/oauth/authorize?state=s")!
  private let callbackURL = URL(string: "https://app.bike4mind.com/ios/auth-callback")!

  /// A clock that moves forward by `step` seconds every time it is read.
  private func steppingClock(_ step: TimeInterval) -> () -> Date {
    var current = Date(timeIntervalSince1970: 0)
    return {
      defer { current += step }
      return current
    }
  }

  func testInstantCancelIsReportedAsFailedToStart() async {
    let authenticator = StartFailureDetectingAuthenticator(FakeWebAuthenticator(.cancel), now: steppingClock(0.4))
    do {
      _ = try await authenticator.authenticate(url: authorizeURL, callbackURL: callbackURL)
      XCTFail("expected a throw")
    } catch {
      XCTAssertEqual(error as? AuthError, .webSessionFailedToStart)
    }
  }

  func testCancelAfterTheSheetCouldBeSeenStaysAUserCancel() async {
    let authenticator = StartFailureDetectingAuthenticator(FakeWebAuthenticator(.cancel), now: steppingClock(3))
    do {
      _ = try await authenticator.authenticate(url: authorizeURL, callbackURL: callbackURL)
      XCTFail("expected a throw")
    } catch {
      XCTAssertEqual(error as? AuthError, .cancelled)
    }
  }

  func testFastSuccessPassesThrough() async throws {
    let authenticator = StartFailureDetectingAuthenticator(
      FakeWebAuthenticator(.approve(code: "c1")), now: steppingClock(0.1))
    let url = try await authenticator.authenticate(url: authorizeURL, callbackURL: callbackURL)
    XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "c1")
  }

  func testSignInSurfacesTheStartFailure() async {
    let auth = AuthController(environment: .production, tokenStore: InMemoryTokenStore())
    do {
      try await auth.signIn(
        using: StartFailureDetectingAuthenticator(FakeWebAuthenticator(.cancel), now: steppingClock(0.2)))
      XCTFail("expected a throw")
    } catch {
      XCTAssertEqual(error as? AuthError, .webSessionFailedToStart)
    }
  }
}
