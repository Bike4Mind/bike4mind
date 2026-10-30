import XCTest

@testable import B4MKit

final class AuthorizationRequestTests: XCTestCase {
  private let pkce = PKCEPair(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")

  private func makeRequest() -> AuthorizationRequest {
    AuthorizationRequest(
      baseURL: ServerEnvironment.productionBaseURL, configuration: .iosApp, pkce: pkce, state: "state-123")
  }

  func testAuthorizationURLCarriesClientRedirectChallengeAndState() throws {
    let url = makeRequest().url
    let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
    let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })

    XCTAssertEqual(components.scheme, "https")
    XCTAssertEqual(components.host, "app.bike4mind.com")
    XCTAssertEqual(components.path, "/oauth/authorize")
    XCTAssertEqual(query["response_type"], "code")
    XCTAssertEqual(query["client_id"], "b4m-ios-app")
    XCTAssertEqual(query["redirect_uri"], "https://app.bike4mind.com/ios/auth-callback")
    XCTAssertEqual(query["code_challenge"], "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    XCTAssertEqual(query["code_challenge_method"], "S256")
    XCTAssertEqual(query["state"], "state-123")
    XCTAssertNil(query["code_verifier"], "the verifier must never leave the device before the token exchange")
  }

  func testAuthorizationURLUsesCustomEnvironmentHostButKeepsUniversalLinkRedirect() throws {
    let request = AuthorizationRequest(
      baseURL: URL(string: "https://staging.example.com")!, configuration: .iosApp, pkce: pkce, state: "s")
    let components = try XCTUnwrap(URLComponents(url: request.url, resolvingAgainstBaseURL: false))
    XCTAssertEqual(components.host, "staging.example.com")
    XCTAssertEqual(
      components.queryItems?.first { $0.name == "redirect_uri" }?.value, "https://app.bike4mind.com/ios/auth-callback")
  }

  func testCallbackYieldsCode() throws {
    let callback = URL(string: "https://app.bike4mind.com/ios/auth-callback?code=abc&state=state-123")!
    XCTAssertEqual(try makeRequest().authorizationCode(from: callback), "abc")
  }

  func testCallbackRejectsStateMismatch() {
    let callback = URL(string: "https://app.bike4mind.com/ios/auth-callback?code=abc&state=forged")!
    XCTAssertThrowsError(try makeRequest().authorizationCode(from: callback)) {
      XCTAssertEqual($0 as? AuthError, .stateMismatch)
    }
  }

  func testCallbackMapsAccessDenied() {
    let callback = URL(string: "https://app.bike4mind.com/ios/auth-callback?error=access_denied&state=state-123")!
    XCTAssertThrowsError(try makeRequest().authorizationCode(from: callback)) {
      XCTAssertEqual($0 as? AuthError, .authorizationDenied)
    }
  }

  func testCallbackRejectsForeignRedirect() {
    let callback = URL(string: "https://evil.example.com/ios/auth-callback?code=abc&state=state-123")!
    XCTAssertThrowsError(try makeRequest().authorizationCode(from: callback)) {
      XCTAssertEqual($0 as? AuthError, .invalidCallback)
    }
  }
}
