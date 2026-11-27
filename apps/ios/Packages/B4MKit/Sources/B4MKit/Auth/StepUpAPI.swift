import Foundation

/// A way to re-prove identity. Passkey is deliberately absent: the server never offers it as the only
/// method, so this app leaves it to the web.
public enum StepUpMethod: String, CaseIterable, Equatable, Sendable {
  case password, totp, email
}

public struct StepUpOptions: Equatable, Sendable {
  /// Only the methods this app can collect, in the order the server listed them.
  public let methods: [StepUpMethod]
  /// Set when this session is already inside its step-up window.
  public let stepUpUntil: Date?

  public init(methods: [StepUpMethod], stepUpUntil: Date?) {
    self.methods = methods
    self.stepUpUntil = stepUpUntil
  }
}

/// The proof a user typed, one case per accepted `method` of `POST /api/auth/step-up`.
public enum StepUpProof: Equatable, Sendable {
  case password(String)
  case totp(String)
  case email(pendingToken: String, code: String)
}

public enum StepUpFailure: Error, Equatable, Sendable {
  /// 400 `step_up_failed`: the proof was wrong or expired. `attemptsRemaining` is absent when the server does not count.
  case rejected(message: String?, attemptsRemaining: Int?)
  /// 429, or 423 when the shared second-factor lockout is reached.
  case rateLimited
  case api(APIError)
}

public protocol StepUpAPI: Sendable {
  func fetchOptions() async throws -> StepUpOptions
  /// Emails a code and returns the pending token that `verify` needs alongside it.
  func sendEmailCode() async throws -> String
  /// Returns when the session's step-up window now ends.
  func verify(_ proof: StepUpProof) async throws -> Date
}

/// Hand-written client for the step-up routes (not in the OpenAPI contract). Server counterparts:
/// apps/client/pages/api/auth/step-up/index.ts, options.ts and email/send.ts. Same bearer and
/// single-401-retry policy as `AccountClient`.
public struct StepUpClient: StepUpAPI {
  private let requester: AuthorizedRequester
  private let tokens: any AccessTokenProviding

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
    self.tokens = tokens
  }

  public func fetchOptions() async throws -> StepUpOptions {
    let response = try await requester.send(method: "GET", path: StepUpWire.optionsPath)
    return try StepUpWire.options(status: response.status, body: response.body)
  }

  public func sendEmailCode() async throws -> String {
    let response = try await requester.send(method: "POST", path: StepUpWire.emailSendPath)
    return try StepUpWire.pendingToken(status: response.status, body: response.body)
  }

  public func verify(_ proof: StepUpProof) async throws -> Date {
    let response: AuthorizedRequester.Response
    do {
      response = try await requester.send(
        method: "POST", path: StepUpWire.verifyPath, jsonBody: StepUpWire.encode(proof))
    } catch let error as APIError {
      throw StepUpFailure.api(error)
    }
    do {
      return try StepUpWire.verifyResult(status: response.status, body: response.body, proof: proof)
    } catch StepUpWire.SessionRevoked.revoked {
      // The server revoked this session (too many wrong passwords). Its access JWT stays valid until it
      // expires, so end the session here instead of waiting for the next 401.
      await tokens.sessionRejected()
      throw StepUpFailure.api(.signedOut)
    }
  }
}

enum StepUpWire {
  static let verifyPath = "api/auth/step-up"
  static let optionsPath = "api/auth/step-up/options"
  static let emailSendPath = "api/auth/step-up/email/send"
  static let failedCode = "step_up_failed"
  static let unavailableCode = "step_up_unavailable"

  /// Internal signal that the failed attempt cost this session its life.
  enum SessionRevoked: Error { case revoked }

  private struct OptionsEnvelope: Decodable {
    let methods: [String]?
    let stepUpUntil: String?
  }

  private struct VerifiedEnvelope: Decodable {
    let stepUpUntil: String
  }

  private struct SendEnvelope: Decodable {
    let pendingToken: String
  }

  private struct FailureEnvelope: Decodable {
    let error: String?
    let code: String?
    let attemptsRemaining: Int?
  }

  private struct Body: Encodable {
    let method: String
    var password: String?
    var code: String?
    var pendingToken: String?
  }

  static func encode(_ proof: StepUpProof) throws -> Data {
    let body: Body
    switch proof {
    case .password(let password): body = Body(method: "password", password: password)
    case .totp(let code): body = Body(method: "totp", code: code)
    case .email(let pendingToken, let code): body = Body(method: "email", code: code, pendingToken: pendingToken)
    }
    return try JSONEncoder().encode(body)
  }

  /// Unknown method strings (passkey, future additions) are dropped rather than failing the decode.
  static func options(status: Int, body: Data) throws -> StepUpOptions {
    guard status == 200 else { throw APIError(status: status) }
    guard let envelope = try? JSONDecoder().decode(OptionsEnvelope.self, from: body) else {
      throw APIError.malformedResponse
    }
    let methods = (envelope.methods ?? []).compactMap(StepUpMethod.init(rawValue:))
    return StepUpOptions(methods: methods, stepUpUntil: envelope.stepUpUntil.flatMap(AccountDeletionWire.parseDate))
  }

  static func pendingToken(status: Int, body: Data) throws -> String {
    guard status == 200 else { throw APIError(status: status) }
    guard let envelope = try? JSONDecoder().decode(SendEnvelope.self, from: body), !envelope.pendingToken.isEmpty
    else { throw APIError.malformedResponse }
    return envelope.pendingToken
  }

  static func verifyResult(status: Int, body: Data, proof: StepUpProof) throws -> Date {
    switch status {
    case 200:
      guard let envelope = try? JSONDecoder().decode(VerifiedEnvelope.self, from: body),
        let until = AccountDeletionWire.parseDate(envelope.stepUpUntil)
      else { throw StepUpFailure.api(.malformedResponse) }
      return until
    case 400:
      let envelope = try? JSONDecoder().decode(FailureEnvelope.self, from: body)
      guard envelope?.code == failedCode else { throw StepUpFailure.api(APIError(status: status)) }
      // Only a password failure can end the session; for the other methods zero means "ask for a new code".
      if case .password = proof, envelope?.attemptsRemaining == 0 { throw SessionRevoked.revoked }
      throw StepUpFailure.rejected(message: envelope?.error, attemptsRemaining: envelope?.attemptsRemaining)
    case 403:
      if (try? JSONDecoder().decode(FailureEnvelope.self, from: body))?.code == unavailableCode {
        throw SessionRevoked.revoked
      }
      throw StepUpFailure.api(.forbidden)
    case 423, 429:
      throw StepUpFailure.rateLimited
    default:
      throw StepUpFailure.api(APIError(status: status))
    }
  }
}
