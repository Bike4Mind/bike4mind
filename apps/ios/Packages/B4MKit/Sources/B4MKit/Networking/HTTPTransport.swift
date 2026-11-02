import Foundation

/// The single seam between B4MKit and the network. Tests substitute a fake so no suite touches a socket.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
  private let session: URLSession
  private let accountSignal: AccountDeletionSignal

  public init(session: URLSession = .shared, accountSignal: AccountDeletionSignal = .shared) {
    self.session = session
    self.accountSignal = accountSignal
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw URLError(.badServerResponse)
    }
    // Every client shares this transport, so one check here routes a pending-deletion account to the
    // restore screen no matter which call noticed first.
    if let notice = AccountDeletionPendingDetector.notice(status: httpResponse.statusCode, body: data) {
      accountSignal.report(notice)
    }
    return (data, httpResponse)
  }
}
