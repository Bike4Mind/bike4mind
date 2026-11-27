import XCTest

@testable import B4MKit

@MainActor
final class AccessTokenRotationTests: XCTestCase {
  func testEveryRefreshPublishesTheNewAccessToken() async throws {
    let clock = TestClock()
    let store = InMemoryTokenStore()
    try store.setRefreshToken("sid.0")
    let minted = Fixtures.jwt(expiresAt: clock.now.addingTimeInterval(1800))
    let transport = FakeTransport { _ in
      (200, Fixtures.json(["accessToken": minted, "refreshToken": "sid.1"]))
    }
    let auth = AuthController(
      environment: .production, tokenStore: store, transport: transport,
      biometricGate: FakeBiometricGate(succeeds: true), preferences: Fixtures.isolatedDefaults(),
      deviceName: { nil }, now: { clock.now })
    auth.restore()

    var rotations = auth.accessTokenRotations().makeAsyncIterator()
    let token = try await auth.accessToken()

    let published = await rotations.next()
    XCTAssertEqual(published, token)
    XCTAssertEqual(published, minted)
  }
}
