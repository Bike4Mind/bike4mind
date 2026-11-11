import XCTest

@testable import B4MKit

private func user(_ fields: [String: Any]) -> Data {
  try! JSONSerialization.data(withJSONObject: fields)
}

final class AccountProfileTests: XCTestCase {
  private func token(_ claims: [String: Any]) -> String {
    let payload = Base64URL.encode(try! JSONSerialization.data(withJSONObject: claims))
    return "e30.\(payload).sig"
  }

  // Fixtures mirror the self view of apps/client/pages/api/users/[id]/index.ts.

  func testProfileReadsNameAndEmail() {
    let profile = AccountProfile(
      userJSON: user(["id": "u1", "username": "sam-d", "name": "Samantha Doe", "email": "sam@example.com"]))
    XCTAssertEqual(profile?.firstName, "Samantha")
    XCTAssertEqual(profile?.displayName, "Samantha Doe")
    XCTAssertEqual(profile?.email, "sam@example.com")
    XCTAssertEqual(profile?.initial, "S")
  }

  func testUsernameStandsInForTheDisplayNameButNotTheFirstName() {
    let profile = AccountProfile(userJSON: user(["username": "pat-l", "name": "  ", "email": " pat@example.com "]))
    XCTAssertNil(profile?.firstName)
    XCTAssertEqual(profile?.displayName, "pat-l")
    XCTAssertEqual(profile?.email, "pat@example.com")
    XCTAssertEqual(profile?.initial, "P")
  }

  func testEmptyAndWrongTypedFieldsReadAsMissing() {
    let profile = AccountProfile(userJSON: user(["name": 5, "username": ["x"], "email": true]))
    XCTAssertEqual(profile, AccountProfile(firstName: nil, displayName: nil, email: nil))
    XCTAssertNil(profile?.initial)
  }

  func testNonObjectBodyIsNoProfile() {
    XCTAssertNil(AccountProfile(userJSON: Data("[1]".utf8)))
    XCTAssertNil(AccountProfile(userJSON: Data("not json".utf8)))
  }

  func testUserIDComesFromTheAccessTokensIDClaim() {
    XCTAssertEqual(
      AccountProfile.userID(fromAccessToken: token(["id": "6a561067a8b145dc4d616cd4", "sid": "s1", "typ": "access"])),
      "6a561067a8b145dc4d616cd4")
  }

  func testUserIDRejectsMissingOrUnsafeIDs() {
    XCTAssertNil(AccountProfile.userID(fromAccessToken: token(["sub": "u1"])))
    XCTAssertNil(AccountProfile.userID(fromAccessToken: token(["id": 42])))
    XCTAssertNil(AccountProfile.userID(fromAccessToken: token(["id": "../account/deletion"])))
    XCTAssertNil(AccountProfile.userID(fromAccessToken: "not-a-jwt"))
  }
}

final class AccountProfileClientTests: XCTestCase {
  private let base = URL(string: "https://app.example.test")!

  func testProfileIsABearerGetOfTheUsersOwnRecord() async throws {
    let body = Data(#"{"id":"u1","username":"alex-r","name":"Alex Rivera","email":"alex@example.com"}"#.utf8)
    let transport = FakeTransport { _ in (200, body) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)

    let profile = try await client.profile(userID: "u1")

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.path(), "/api/users/u1")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
    XCTAssertEqual(profile, AccountProfile(firstName: "Alex", displayName: "Alex Rivera", email: "alex@example.com"))
  }

  func testNotFoundSurfacesAsAPIError() async {
    let transport = FakeTransport { _ in (404, Data(#"{"error":"User not found"}"#.utf8)) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.profile(userID: "u1")
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? APIError, .notFound)
    }
  }

  func testUnreadableBodyIsMalformed() async {
    let transport = FakeTransport { _ in (200, Data("[]".utf8)) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.profile(userID: "u1")
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }

  func testUnsafeIDNeverReachesTheNetwork() async {
    let transport = FakeTransport { _ in (200, Data()) }
    let client = AccountClient(baseURL: base, tokens: FakeTokens(), transport: transport)
    do {
      _ = try await client.profile(userID: "../account/deletion")
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? APIError, .notFound)
    }
    let requests = await transport.requests
    XCTAssertTrue(requests.isEmpty)
  }
}
