import XCTest

@testable import B4MKit

final class PKCETests: XCTestCase {
  func testChallengeIsS256OfVerifierPerRFC7636AppendixB() {
    let pair = PKCEPair(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    XCTAssertEqual(pair.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    XCTAssertEqual(pair.method, "S256")
  }

  func testGeneratedVerifierMatchesServerConstraints() {
    let pair = PKCEPair.generate()
    let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    XCTAssertEqual(pair.verifier.count, 43)
    XCTAssertEqual(pair.challenge.count, 43)
    XCTAssertTrue(pair.verifier.unicodeScalars.allSatisfy(unreserved.contains))
    XCTAssertNotEqual(pair.verifier, PKCEPair.generate().verifier)
  }
}
