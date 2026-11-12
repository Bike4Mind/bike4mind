import XCTest

@testable import B4MKit

final class ServerEnvironmentTests: XCTestCase {
  private func environment(_ string: String) throws -> ServerEnvironment {
    ServerEnvironment(url: try XCTUnwrap(URL(string: string)))
  }

  func testProductionURLMapsToProduction() throws {
    XCTAssertEqual(try environment("https://app.bike4mind.com"), .production)
    XCTAssertEqual(try environment("https://app.bike4mind.com/"), .production)
    XCTAssertEqual(try environment("https://app.bike4mind.com:443"), .production)
  }

  func testProductionHostIsCaseInsensitive() throws {
    XCTAssertEqual(try environment("https://APP.bike4mind.com"), .production)
  }

  func testOtherURLsStayCustom() throws {
    for string in [
      "https://app.staging.bike4mind.com",
      "http://app.bike4mind.com",
      "https://app.bike4mind.com:8443",
      "https://app.bike4mind.com/preview",
    ] {
      let url = try XCTUnwrap(URL(string: string))
      XCTAssertEqual(ServerEnvironment(url: url), .custom(url), string)
    }
  }

  func testTypedProductionURLGetsFirstPartyClient() {
    let environment = ServerEnvironment(url: ServerEnvironment.productionBaseURL)
    XCTAssertEqual(OAuthConfiguration.debugBuild(for: environment), .iosApp)
  }
}
