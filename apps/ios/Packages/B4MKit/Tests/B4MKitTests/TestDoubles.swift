import Foundation
import XCTest

@testable import B4MKit

/// Scripted, counting HTTP transport. Requests are recorded in arrival order.
actor FakeTransport: HTTPTransport {
  typealias Responder = @Sendable (URLRequest) async throws -> (status: Int, body: Data)

  private(set) var requests: [URLRequest] = []
  private var responder: Responder

  init(responder: @escaping Responder = { _ in (404, Data()) }) {
    self.responder = responder
  }

  func respond(with responder: @escaping Responder) {
    self.responder = responder
  }

  func requests(to path: String) -> [URLRequest] {
    requests.filter { $0.url?.path() == path }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    let (status, body) = try await responder(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
    return (body, response)
  }
}

@MainActor
final class FakeWebAuthenticator: WebAuthenticating {
  enum Behavior {
    case approve(code: String)
    case deny
    case cancel
  }

  private(set) var openedURL: URL?
  private let behavior: Behavior

  init(_ behavior: Behavior) {
    self.behavior = behavior
  }

  func authenticate(url: URL, callbackURL: URL) async throws -> URL {
    openedURL = url
    let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value
    var components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)!
    switch behavior {
    case .approve(let code):
      components.queryItems = [URLQueryItem(name: "code", value: code), URLQueryItem(name: "state", value: state)]
    case .deny:
      components.queryItems = [
        URLQueryItem(name: "error", value: "access_denied"), URLQueryItem(name: "state", value: state),
      ]
    case .cancel:
      throw AuthError.cancelled
    }
    return components.url!
  }
}

struct FakeBiometricGate: BiometricGate {
  let succeeds: Bool
  func canEvaluate() -> Bool { true }
  func evaluate(reason: String) async -> Bool { succeeds }
}

/// Mutable clock shared between the test and the controller.
final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  init(_ start: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
    current = start
  }

  var now: Date {
    lock.withLock { current }
  }

  func advance(by interval: TimeInterval) {
    lock.withLock { current = current.addingTimeInterval(interval) }
  }
}

enum Fixtures {
  /// Unsigned JWT with an `exp` claim; the client only reads the payload.
  static func jwt(expiresAt: Date, subject: String = "user-1") -> String {
    func segment(_ object: [String: Any]) -> String {
      Base64URL.encode(try! JSONSerialization.data(withJSONObject: object))
    }
    let header = segment(["alg": "HS256", "typ": "JWT"])
    let payload = segment(["sub": subject, "exp": Int(expiresAt.timeIntervalSince1970)])
    return "\(header).\(payload).signature"
  }

  static func json(_ object: [String: Any]) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
  }

  static func jsonBody(of request: URLRequest) -> [String: Any] {
    guard let body = request.httpBody,
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    else {
      XCTFail("Request has no JSON body: \(request)")
      return [:]
    }
    return object
  }

  static func isolatedDefaults(_ name: String = #function) -> UserDefaults {
    let suite = "b4mkit.tests.\(name).\(UUID().uuidString)"
    return UserDefaults(suiteName: suite)!
  }
}
