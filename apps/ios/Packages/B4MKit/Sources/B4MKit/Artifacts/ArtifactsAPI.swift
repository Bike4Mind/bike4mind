import B4MClient
import Foundation

/// The read-only artifact surface the screens depend on. Every method throws `APIError`.
public protocol ArtifactsAPI: Sendable {
  /// `features.artifacts` from `GET /api/v1/client-config`; a missing key reads as off.
  func artifactsEnabled() async throws -> Bool
  /// The caller's own artifacts, newest first.
  func listArtifacts(cursor: String?, limit: Int) async throws -> Page<ArtifactSummary>
  func artifact(id: String) async throws -> Artifact
}

/// `ArtifactsAPI` over the generated client for the list and detail calls, plus the client-config feature flag.
public struct ArtifactsClient: ArtifactsAPI {
  private let api: APIClient
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    api = APIClient(baseURL: baseURL, tokens: tokens, transport: transport)
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func artifactsEnabled() async throws -> Bool {
    let response = try await requester.send(method: "GET", path: ArtifactsWire.clientConfigPath)
    return try ArtifactsWire.artifactsEnabled(status: response.status, body: response.body)
  }

  public func listArtifacts(cursor: String?, limit: Int) async throws -> Page<ArtifactSummary> {
    try await api.listArtifacts(cursor: cursor, limit: limit)
  }

  public func artifact(id: String) async throws -> Artifact {
    try await api.artifact(id: id)
  }
}

/// Parsing for the one hand-read artifact route (the feature flag); see `VoiceWire` for the same pattern.
enum ArtifactsWire {
  static let clientConfigPath = "api/v1/client-config"

  static func artifactsEnabled(status: Int, body: Data) throws -> Bool {
    guard (200..<300).contains(status) else { throw APIError(status: status) }
    guard let root = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
      throw APIError.malformedResponse
    }
    let features = root["features"] as? [String: Any]
    return features?["artifacts"] as? Bool ?? false
  }
}

extension APIClient {
  func listArtifacts(cursor: String?, limit: Int) async throws -> Page<ArtifactSummary> {
    try await call {
      let output = try await client.listArtifacts(query: .init(limit: limit, cursor: cursor))
      switch output {
      case .ok(let ok):
        let body = try ok.body.json
        return Page(items: body.data.map { ArtifactSummary(wire: $0.wire) }, nextCursor: body.nextCursor)
      case .unauthorized: throw APIError.signedOut
      case .forbidden: throw APIError.forbidden
      case .tooManyRequests: throw APIError.rateLimited
      case .upgradeRequired: throw APIError.upgradeRequired
      case .undocumented(let status, _): throw APIError(status: status)
      default: throw APIError.malformedResponse
      }
    }
  }

  func artifact(id: String) async throws -> Artifact {
    try await call {
      let output = try await client.getArtifact(path: .init(id: id))
      switch output {
      case .ok(let ok):
        let body = try ok.body.json
        return Artifact(summary: ArtifactSummary(wire: body.wire), content: body.content)
      case .unauthorized: throw APIError.signedOut
      case .forbidden: throw APIError.forbidden
      case .notFound: throw APIError.notFound
      case .tooManyRequests: throw APIError.rateLimited
      case .upgradeRequired: throw APIError.upgradeRequired
      case .undocumented(let status, _): throw APIError(status: status)
      default: throw APIError.malformedResponse
      }
    }
  }
}

/// The fields both generated payloads share, so one mapping serves the list row and the detail.
struct ArtifactWire {
  let id: String
  let type: String
  let title: String
  let description: String?
  let version: Int
  let sessionID: String?
  let updatedAt: String
}

extension Components.Schemas.ListArtifactsResponse200.DataPayloadPayload {
  fileprivate var wire: ArtifactWire {
    ArtifactWire(
      id: id, type: _type, title: title, description: description, version: version, sessionID: sessionId,
      updatedAt: updatedAt)
  }
}

extension Components.Schemas.GetArtifactResponse200 {
  fileprivate var wire: ArtifactWire {
    ArtifactWire(
      id: id, type: _type, title: title, description: description, version: version, sessionID: sessionId,
      updatedAt: updatedAt)
  }
}

extension ArtifactSummary {
  fileprivate init(wire: ArtifactWire) {
    self.init(
      id: wire.id, kind: ArtifactKind(wire: wire.type), title: wire.title, summary: wire.description,
      version: wire.version, sessionID: wire.sessionID,
      updatedAt: LenientISO8601DateTranscoder.parse(wire.updatedAt) ?? .distantPast)
  }
}
