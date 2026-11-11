import XCTest

@testable import B4MKit

final class AccountProfileTests: XCTestCase {
  private func jwt(_ claims: [String: Any]) -> String {
    let payload = Base64URL.encode(try! JSONSerialization.data(withJSONObject: claims))
    return "e30.\(payload).sig"
  }

  func testProfileReadsNameAndEmailClaims() {
    let profile = AccountProfile(jwt: jwt(["given_name": "Sam", "name": "Samantha Doe", "email": "sam@example.com"]))
    XCTAssertEqual(profile, AccountProfile(firstName: "Sam", displayName: "Samantha Doe", email: "sam@example.com"))
    XCTAssertEqual(profile?.initial, "S")
  }

  func testDisplayNameFallsBackToGivenAndFamilyName() {
    let profile = AccountProfile(jwt: jwt(["given_name": "Pat", "family_name": "Lee"]))
    XCTAssertEqual(profile?.displayName, "Pat Lee")
    XCTAssertEqual(profile?.firstName, "Pat")
  }

  func testInitialIsUppercasedAndFallsBackToTheDisplayName() {
    XCTAssertEqual(AccountProfile(firstName: "alex", displayName: nil, email: nil).initial, "A")
    XCTAssertEqual(AccountProfile(firstName: nil, displayName: "zoe q", email: nil).initial, "Z")
  }

  func testNoNameMeansNoInitialEvenWithAnEmail() {
    let profile = AccountProfile(jwt: jwt(["sub": "user-1", "email": " a@example.com "]))
    XCTAssertNil(profile?.initial)
    XCTAssertNil(profile?.displayName)
    XCTAssertEqual(profile?.email, "a@example.com")
  }

  func testBlankClaimsAreTreatedAsMissing() {
    let profile = AccountProfile(jwt: jwt(["given_name": "  ", "name": "", "email": " "]))
    XCTAssertEqual(profile, AccountProfile(firstName: nil, displayName: nil, email: nil))
  }

  func testFirstNameIsTheFirstWordOfNameWithoutAGivenName() {
    XCTAssertEqual(AccountProfile(jwt: jwt(["name": "Pat Doe"]))?.firstName, "Pat")
    XCTAssertNil(AccountProfile(jwt: jwt(["sub": "user-1"]))?.firstName)
  }

  func testUnreadableTokenHasNoProfile() {
    XCTAssertNil(AccountProfile(jwt: "not-a-jwt"))
  }

  func testPayloadThatIsNotAJSONObjectHasNoProfile() {
    let array = Base64URL.encode(Data("[1,2]".utf8))
    XCTAssertNil(AccountProfile(jwt: "e30.\(array).sig"))
    let text = Base64URL.encode(Data("hello".utf8))
    XCTAssertNil(AccountProfile(jwt: "e30.\(text).sig"))
  }

  func testNonStringClaimsAreTreatedAsMissing() {
    let profile = AccountProfile(jwt: jwt(["name": 5, "given_name": ["Sam"], "email": true]))
    XCTAssertEqual(profile, AccountProfile(firstName: nil, displayName: nil, email: nil))
  }

  func testInitialKeepsTheWholeFirstCharacter() {
    // A flag is two scalars and an accented letter may be two; the avatar must not split either.
    let flag = "\u{1F1EF}\u{1F1F5}"
    XCTAssertEqual(AccountProfile(firstName: flag + "ko", displayName: nil, email: nil).initial, flag)
    XCTAssertEqual(AccountProfile(firstName: "e\u{301}lodie", displayName: nil, email: nil).initial, "E\u{301}")
  }
}
