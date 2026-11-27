import Foundation

public enum InstructionError: Error, Equatable, Sendable {
  /// The account already keeps `AssistantInstruction.maxCount` instructions.
  case limitReached
  /// The server refused the text (empty, whitespace only, or too long).
  case invalidText
  case api(APIError)
}

public protocol InstructionAPI: Sendable {
  /// The user's instructions, oldest first.
  func list() async throws -> [AssistantInstruction]
  func add(text: String) async throws -> AssistantInstruction
  /// Removing one that is already gone succeeds.
  func remove(id: String) async throws
}

/// Hand-written client for `/api/v1/assistant/instructions` (JWT bearer). Throws `InstructionError`.
public struct InstructionClient: InstructionAPI {
  private static let path = "api/v1/assistant/instructions"
  private static let limitReachedCode = "instruction_limit_reached"
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  private struct ListResponse: Decodable {
    let instructions: [AssistantInstruction]
  }

  private struct ErrorEnvelope: Decodable {
    let errorCode: String?
  }

  public func list() async throws -> [AssistantInstruction] {
    let response = try await send(method: "GET", path: Self.path)
    guard response.status == 200 else { throw InstructionError.api(APIError(status: response.status)) }
    return try decode(ListResponse.self, from: response.body).instructions
  }

  public func add(text: String) async throws -> AssistantInstruction {
    let body = try JSONEncoder().encode(["text": text])
    let response = try await send(method: "POST", path: Self.path, jsonBody: body)
    switch response.status {
    case 200..<300:
      return try decode(AssistantInstruction.self, from: response.body)
    case 400 where Self.errorCode(in: response.body) == Self.limitReachedCode:
      throw InstructionError.limitReached
    case 422:
      throw InstructionError.invalidText
    default:
      throw InstructionError.api(APIError(status: response.status))
    }
  }

  public func remove(id: String) async throws {
    guard DeepLinkRouter.isValidIdentifier(id) else { return }
    let response = try await send(method: "DELETE", path: "\(Self.path)/\(id)")
    guard (200..<300).contains(response.status) || response.status == 404 else {
      throw InstructionError.api(APIError(status: response.status))
    }
  }

  private func send(method: String, path: String, jsonBody: Data? = nil) async throws -> AuthorizedRequester.Response {
    do {
      return try await requester.send(method: method, path: path, jsonBody: jsonBody)
    } catch let error as APIError {
      throw InstructionError.api(error)
    }
  }

  private static func errorCode(in body: Data) -> String? {
    (try? JSONDecoder().decode(ErrorEnvelope.self, from: body))?.errorCode
  }

  private func decode<Body: Decodable>(_ type: Body.Type, from data: Data) throws -> Body {
    do {
      return try BriefClient.decoder.decode(type, from: data)
    } catch {
      throw InstructionError.api(.malformedResponse)
    }
  }
}
