import XCTest

@testable import B4MKit

final class ClientIdentityTests: XCTestCase {
  func testMarketingVersionsArePaddedToSemVer() {
    XCTAssertEqual(ClientIdentity.semanticVersion("1"), "1.0.0")
    XCTAssertEqual(ClientIdentity.semanticVersion("0.1"), "0.1.0")
    XCTAssertEqual(ClientIdentity.semanticVersion("2.10.3"), "2.10.3")
  }

  func testVersionsTheServerCannotCompareAreNotSent() {
    for bad in ["", "1.2.3.4", "1..2", "01.2.3", "1.2.x", "+1.2.3", "1.2.3-beta"] {
      XCTAssertNil(ClientIdentity.semanticVersion(bad), bad)
    }
  }

  func testBothHeadersAreStamped() {
    var request = URLRequest(url: URL(string: "https://app.example.test/api/x")!)
    ClientIdentity(name: ClientIdentity.iOSClientName, marketingVersion: "0.1").apply(to: &request)
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Name"), "b4m-ios")
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Version"), "0.1.0")
  }

  func testAnUnreadableVersionSendsNeitherHeader() {
    var request = URLRequest(url: URL(string: "https://app.example.test/api/x")!)
    ClientIdentity(name: ClientIdentity.iOSClientName, marketingVersion: nil).apply(to: &request)
    XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Name"))
    XCTAssertNil(request.value(forHTTPHeaderField: "X-Client-Version"))
  }

  func testTheUpgradeAnswerIsRecognizedWithItsMinimumVersion() {
    let body = Data(
      #"{"error":"too old","errorCode":"upgrade_required","client_name":"b4m-ios","minimum_version":"1.2.0"}"#.utf8)
    XCTAssertEqual(ClientUpgradeDetector.notice(status: 426, body: body), ClientUpgradeNotice(minimumVersion: "1.2.0"))
    XCTAssertEqual(ClientUpgradeDetector.notice(status: 426, body: Data()), ClientUpgradeNotice(minimumVersion: nil))
    XCTAssertNil(ClientUpgradeDetector.notice(status: 400, body: body))
  }

  func testA426FoldsIntoUpgradeRequired() {
    XCTAssertEqual(APIError(status: 426), .upgradeRequired)
    XCTAssertFalse(APIError.upgradeRequired.isRetryable)
  }

  @MainActor
  func testTheStatusLatchesOntoTheFirstAnswerThatNamesAVersion() {
    let status = ClientUpgradeStatus(signal: ClientUpgradeSignal())
    XCTAssertFalse(status.isUpgradeRequired)
    status.receive(ClientUpgradeNotice(minimumVersion: nil))
    status.receive(ClientUpgradeNotice(minimumVersion: "1.2.0"))
    status.receive(ClientUpgradeNotice(minimumVersion: nil))
    XCTAssertTrue(status.isUpgradeRequired)
    XCTAssertEqual(status.notice?.minimumVersion, "1.2.0")
  }
}

/// The shared transport is the one place the identity is declared, so it is tested through a real
/// `URLSession` with a stubbed protocol rather than through `FakeTransport`.
final class URLSessionTransportIdentityTests: XCTestCase {
  func testEveryRequestDeclaresTheClientAndA426IsBroadcast() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [UpgradeRequiredProtocol.self]
    let signal = ClientUpgradeSignal()
    let received = LockedBox<ClientUpgradeNotice?>(nil)
    signal.observe { received.set($0) }
    let transport = URLSessionTransport(
      session: URLSession(configuration: configuration), accountSignal: AccountDeletionSignal(),
      identity: ClientIdentity(name: ClientIdentity.iOSClientName, marketingVersion: "3.1"), upgradeSignal: signal)

    let (_, response) = try await transport.send(URLRequest(url: URL(string: "https://app.example.test/api/x")!))

    XCTAssertEqual(response.statusCode, 426)
    let sent = try XCTUnwrap(UpgradeRequiredProtocol.lastRequest)
    XCTAssertEqual(sent.value(forHTTPHeaderField: "X-Client-Name"), "b4m-ios")
    XCTAssertEqual(sent.value(forHTTPHeaderField: "X-Client-Version"), "3.1.0")
    XCTAssertEqual(received.value, ClientUpgradeNotice(minimumVersion: "3.2.0"))
  }
}

private final class LockedBox<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value { lock.withLock { stored } }
  func set(_ value: Value) { lock.withLock { stored = value } }
}

private final class UpgradeRequiredProtocol: URLProtocol, @unchecked Sendable {
  private static let captured = LockedBox<URLRequest?>(nil)
  static var lastRequest: URLRequest? { captured.value }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.captured.set(request)
    let body = Data(#"{"error":"old","errorCode":"upgrade_required","client_name":"b4m-ios","minimum_version":"3.2.0"}"#.utf8)
    let response = HTTPURLResponse(url: request.url!, statusCode: 426, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
