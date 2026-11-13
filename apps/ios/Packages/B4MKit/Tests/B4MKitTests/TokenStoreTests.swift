import Security
import XCTest

@testable import B4MKit

final class TokenStoreTests: XCTestCase {
  func testInMemoryTokenStoreRoundTrip() throws {
    try assertRoundTrip(InMemoryTokenStore())
  }

  func testKeychainTokenStoreRoundTrip() throws {
    let store = KeychainTokenStore(service: "com.bike4mind.tests.\(UUID().uuidString)")
    do {
      try assertRoundTrip(store)
    } catch let error as KeychainError where error.status == errSecMissingEntitlement {
      // Hostless test bundles on some simulator/macOS setups have no keychain entitlement.
      throw XCTSkip("Keychain unavailable to this test host (errSecMissingEntitlement)")
    }
  }

  private func assertRoundTrip(_ store: some TokenStore, file: StaticString = #filePath, line: UInt = #line) throws {
    try store.setRefreshToken(nil)
    XCTAssertNil(try store.refreshToken(), file: file, line: line)

    try store.setRefreshToken("sid.first")
    XCTAssertEqual(try store.refreshToken(), "sid.first", file: file, line: line)

    try store.setRefreshToken("sid.rotated")
    XCTAssertEqual(
      try store.refreshToken(), "sid.rotated", "overwrite must replace, not duplicate", file: file, line: line)

    try store.setRefreshToken(nil)
    XCTAssertNil(try store.refreshToken(), file: file, line: line)
  }
}
