import Foundation

public protocol BriefScheduleAPI: Sendable {
  /// The saved schedule, or nil when the user never saved one.
  func schedule() async throws -> BriefSchedule?
  /// Replaces the schedule and returns what the server stored.
  func save(_ schedule: BriefSchedule) async throws -> BriefSchedule
}

/// Hand-written client for `GET`/`PUT /api/v1/briefs/schedule` until the generated client's spec snapshot
/// includes them.
public struct BriefScheduleClient: BriefScheduleAPI {
  private let requester: AuthorizedRequester
  private static let path = "api/v1/briefs/schedule"

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  /// `nextBriefAt` is also returned but not read here.
  private struct Envelope: Decodable {
    let schedule: BriefSchedule?
  }

  public func schedule() async throws -> BriefSchedule? {
    try decode(try await requester.send(method: "GET", path: Self.path)).schedule
  }

  public func save(_ schedule: BriefSchedule) async throws -> BriefSchedule {
    let body = try JSONEncoder().encode(schedule)
    let envelope = try decode(try await requester.send(method: "PUT", path: Self.path, jsonBody: body))
    guard let saved = envelope.schedule else { throw APIError.malformedResponse }
    return saved
  }

  private func decode(_ response: AuthorizedRequester.Response) throws -> Envelope {
    guard (200..<300).contains(response.status) else { throw APIError(status: response.status) }
    do {
      return try JSONDecoder().decode(Envelope.self, from: response.body)
    } catch {
      throw APIError.malformedResponse
    }
  }
}
