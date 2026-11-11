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

  func testUnreadableTokenHasNoProfile() {
    XCTAssertNil(AccountProfile(jwt: "not-a-jwt"))
  }
}
