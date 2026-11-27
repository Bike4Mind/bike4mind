import Foundation

/// One premium voice from the deployment's ElevenLabs workspace.
public struct VoiceOption: Equatable, Hashable, Identifiable, Sendable {
  public let id: String
  public let name: String
  /// Provider labels such as `accent` and `gender`. Often empty.
  public let labels: [String: String]
  /// A short static sample; playing it costs no credits.
  public let previewURL: URL?

  public init(id: String, name: String, labels: [String: String] = [:], previewURL: URL? = nil) {
    self.id = id
    self.name = name
    self.labels = labels
    self.previewURL = previewURL
  }
}

/// Why a voice call did not produce a usable result. Every case is a reason to fall back to on-device speech.
public enum VoiceWireError: Error, Equatable, Sendable {
  /// Premium voices are switched off or not configured on this deployment (403/503 on the catalog, or a
  /// `provider_not_configured` 401 on speech).
  case unavailable
  /// The clip outlasted the server's synchronous wait and became a background job (202).
  case pending
  case insufficientCredits
  /// The server or provider rejected the request (bad voice, oversized text, validation).
  case rejected(status: Int)
  case rateLimited
  case server(status: Int)
  case offline
  case signedOut
  case malformedResponse
}

/// Every method throws `VoiceWireError`, or `CancellationError` when its task is cancelled.
public protocol VoiceAPI: Sendable {
  /// `features.voice_sessions` from `GET /api/v1/client-config`; a missing key reads as off.
  func voiceSessionsEnabled() async throws -> Bool
  func listVoices() async throws -> [VoiceOption]
  /// One mp3 clip of `text` spoken in `voiceID`.
  func synthesizeSpeech(text: String, voiceID: String) async throws -> Data
}

/// Hand-written client for the voice routes (see `VoiceWire`).
public struct VoiceClient: VoiceAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  public func voiceSessionsEnabled() async throws -> Bool {
    let response = try await send(method: "GET", path: VoiceWire.clientConfigPath)
    return try VoiceWire.voiceSessionsEnabled(status: response.status, body: response.body)
  }

  public func listVoices() async throws -> [VoiceOption] {
    let response = try await send(method: "GET", path: VoiceWire.voicesPath)
    return try VoiceWire.voices(status: response.status, body: response.body)
  }

  public func synthesizeSpeech(text: String, voiceID: String) async throws -> Data {
    let body: Data
    do {
      body = try JSONEncoder().encode(VoiceWire.SpeechBody(text: text, voice: voiceID))
    } catch {
      throw VoiceWireError.malformedResponse
    }
    let response = try await send(method: "POST", path: VoiceWire.speechPath, jsonBody: body)
    return try VoiceWire.speech(response)
  }

  private func send(
    method: String, path: String, jsonBody: Data? = nil
  ) async throws
    -> AuthorizedRequester.Response
  {
    do {
      return try await requester.send(method: method, path: path, jsonBody: jsonBody, codedUnauthorizedIsAnswer: true)
    } catch let error as APIError {
      throw VoiceWire.error(from: error)
    }
  }
}

/// Wire format for the voice routes. Keep in sync with apps/client/pages/api/v1/client-config.ts,
/// apps/client/pages/api/v1/voice/voices.ts (shape from b4m-core/voice/src/voicesCache.ts) and
/// apps/client/pages/api/ai/tts.ts.
enum VoiceWire {
  static let clientConfigPath = "api/v1/client-config"
  static let voicesPath = "api/v1/voice/voices"
  static let speechPath = "api/ai/tts"

  struct SpeechBody: Encodable {
    let text: String
    let provider = "elevenlabs"
    /// Always sent: without it the server speaks in the account's web `preferredVoice`.
    let voice: String
    let format = "mp3"
    let encoding = "binary"
    /// Without it every spoken reply chunk is saved to the user's Files (`shouldPersistGeneratedAudio`).
    let preview = true
  }

  static func voiceSessionsEnabled(status: Int, body: Data) throws -> Bool {
    guard (200..<300).contains(status) else { throw error(status: status, body: body) }
    guard let root = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
      throw VoiceWireError.malformedResponse
    }
    let features = root["features"] as? [String: Any]
    return features?["voice_sessions"] as? Bool ?? false
  }

  static func voices(status: Int, body: Data) throws -> [VoiceOption] {
    if status == 403 || status == 503 { throw VoiceWireError.unavailable }
    guard (200..<300).contains(status) else { throw error(status: status, body: body) }
    guard let root = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let rows = root["voices"] as? [[String: Any]]
    else { throw VoiceWireError.malformedResponse }
    return rows.compactMap(voice(from:))
  }

  private static func voice(from row: [String: Any]) -> VoiceOption? {
    guard let id = row["id"] as? String, !id.isEmpty, let name = row["name"] as? String else { return nil }
    let labels = (row["labels"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
    let previewURL = (row["previewUrl"] as? String).flatMap(URL.init(string:)).flatMap { url in
      url.scheme?.lowercased() == "https" ? url : nil
    }
    return VoiceOption(id: id, name: name, labels: labels, previewURL: previewURL)
  }

  static func speech(_ response: AuthorizedRequester.Response) throws -> Data {
    switch response.status {
    case 200:
      if let type = response.contentType?.lowercased(), !type.hasPrefix("audio/") {
        throw VoiceWireError.malformedResponse
      }
      guard !response.body.isEmpty else { throw VoiceWireError.malformedResponse }
      return response.body
    case 202: throw VoiceWireError.pending
    default:
      if (200..<300).contains(response.status) { throw VoiceWireError.malformedResponse }
      throw error(status: response.status, body: response.body)
    }
  }

  static func error(status: Int, body: Data) -> VoiceWireError {
    switch status {
    // A coded 401 is the provider's credential failing (tts.ts), not the user's session.
    case 401 where errorCode(in: body) == "provider_not_configured": return .unavailable
    case 401 where errorCode(in: body) != nil: return .rejected(status: 401)
    case 401: return .signedOut
    case 422 where errorCode(in: body) == "insufficient_credits": return .insufficientCredits
    case 429: return .rateLimited
    case 400..<500: return .rejected(status: status)
    default: return .server(status: status)
    }
  }

  static func error(from apiError: APIError) -> VoiceWireError {
    switch apiError {
    case .signedOut: .signedOut
    case .offline: .offline
    case .rateLimited: .rateLimited
    case .forbidden: .rejected(status: 403)
    case .notFound: .rejected(status: 404)
    case .conflict: .rejected(status: 409)
    case .upgradeRequired: .rejected(status: 426)
    case .server(let status): .server(status: status)
    case .malformedResponse: .malformedResponse
    }
  }

  private static func errorCode(in body: Data) -> String? {
    AuthorizedRequester.errorCode(in: body)
  }
}
