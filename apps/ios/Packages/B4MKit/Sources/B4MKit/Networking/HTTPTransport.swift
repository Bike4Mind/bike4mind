import Foundation

/// The single seam between B4MKit and the network. Tests substitute a fake so no suite touches a socket.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
  private let session: URLSession
  private let accountSignal: AccountDeletionSignal
  private let identity: ClientIdentity
  private let upgradeSignal: ClientUpgradeSignal

  public init(
    session: URLSession = .shared, accountSignal: AccountDeletionSignal = .shared,
    identity: ClientIdentity = .current, upgradeSignal: ClientUpgradeSignal = .shared
  ) {
    self.session = session
    self.accountSignal = accountSignal
    self.identity = identity
    self.upgradeSignal = upgradeSignal
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    // Every client (generated, hand-written, auth, realtime ticket) sends through here, so the client
    // identity is declared once for all of them.
    var request = request
    identity.apply(to: &request)
    let (data, response) = try await session.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw URLError(.badServerResponse)
    }
    // Every client shares this transport, so one check here routes a pending-deletion account to the
    // restore screen no matter which call noticed first.
    if let notice = AccountDeletionPendingDetector.notice(status: httpResponse.statusCode, body: data) {
      accountSignal.report(notice)
    }
    if let notice = ClientUpgradeDetector.notice(status: httpResponse.statusCode, body: data) {
      upgradeSignal.report(notice)
    }
    return (data, httpResponse)
  }
}
