import XCTest

@testable import B4MKit

final class AccessTokenTests: XCTestCase {
  func testExpiryComesFromJWTExpClaim() {
    let expiry = Date(timeIntervalSince1970: 1_800_001_800)
    let token = AccessToken(value: Fixtures.jwt(expiresAt: expiry), issuedAt: Date(timeIntervalSince1970: 0))
    XCTAssertEqual(token.expiresAt, expiry)
  }

  func testTokenIsUnusableInsideTheLeewayBeforeExpiry() {
    let expiry = Date(timeIntervalSince1970: 1_800_001_800)
    let token = AccessToken(value: Fixtures.jwt(expiresAt: expiry), issuedAt: expiry.addingTimeInterval(-1800))
    XCTAssertTrue(token.isUsable(at: expiry.addingTimeInterval(-61)))
    XCTAssertFalse(token.isUsable(at: expiry.addingTimeInterval(-59)))
  }

  func testOpaqueTokenFallsBackToConservativeLifetime() {
    let issued = Date(timeIntervalSince1970: 1_800_000_000)
    let token = AccessToken(value: "not-a-jwt", issuedAt: issued)
    XCTAssertEqual(token.expiresAt, issued.addingTimeInterval(AccessToken.fallbackLifetime))
  }
}
