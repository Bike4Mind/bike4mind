import Foundation

/// The presigned upload the server minted for one file. `uploadURL` is a one-shot S3 PUT whose signature
/// binds the exact byte count and expires at `expiresAt` (ten minutes on the server today).
public struct UploadTicket: Hashable, Sendable, Codable {
  public let fileID: String
  public let uploadURL: URL
  public let expiresAt: Date

  public init(fileID: String, uploadURL: URL, expiresAt: Date) {
    self.fileID = fileID
    self.uploadURL = uploadURL
    self.expiresAt = expiresAt
  }
}

/// The server's scan state of an uploaded file; a file is usable once it is `clean`.
public enum RemoteFileStatus: String, Sendable, Equatable {
  case pending, scanning, clean, blocked
  /// A record that predates scanning (`moderation_status: null`); usable.
  case unscanned
}

public struct LakeSummary: Identifiable, Hashable, Sendable, Codable {
  public let id: String
  public let name: String
  public let fileCount: Int
  /// Built-in lakes are platform-owned and read-only, so they are never offered as a destination.
  public let isBuiltIn: Bool

  public init(id: String, name: String, fileCount: Int, isBuiltIn: Bool) {
    self.id = id
    self.name = name
    self.fileCount = fileCount
    self.isBuiltIn = isBuiltIn
  }
}

/// The server refused the request on its merits (HTTP 400/422); `message` is its explanation, safe to show.
public enum CaptureError: Error, Equatable, Sendable {
  case rejected(message: String)
  /// The chat turn that carries a session capture was refused up front (out of credits, spend cap).
  case turnRefused(message: String?)
  case blocked
  case payloadMissing
}

/// Everything capture asks of the backend. Hand-written: these are public `/api/v1` contracts that the
/// generated client's operation filter does not include yet (see `CaptureClient`).
public protocol CaptureAPI: Sendable {
  func createUpload(fileName: String, mimeType: String, byteCount: Int) async throws -> UploadTicket
  func fileStatus(fileID: String) async throws -> RemoteFileStatus
  func setNotes(fileID: String, notes: String) async throws
  func listLakes(cursor: String?, limit: Int) async throws -> Page<LakeSummary>
  /// Idempotent: adding an existing member succeeds.
  func addFileToLake(lakeID: String, fileID: String) async throws
  /// Sends a chat turn into `sessionID` carrying the uploaded files. Not idempotent.
  func sendSessionMessage(sessionID: String, message: String, fileIDs: [String]) async throws
}

/// Hand-written client over `AuthorizedRequester` (bearer, one 401 retry, sign-out on the second).
///
/// Routes, all public contracts in `b4m-core/common/src/api-contract/contracts`:
/// - `POST  /api/v1/files`                           createFileUpload (files.contract.ts)
/// - `GET   /api/v1/files/{id}`                      getFile
/// - `PATCH /api/v1/files/{id}`                      updateFile (`notes`)
/// - `GET   /api/v1/data-lakes`                      listDataLakes (dataLakes.contract.ts)
/// - `POST  /api/v1/data-lakes/{id}/files/{file_id}` addDataLakeFile
/// - `POST  /api/chat`                               sendChatMessage with `fileIds` (chat.contract.ts)
///
/// Keep in sync with those contracts. They move into `B4MClient` (and behind `B4MAPI`) when the generator's
/// operation filter takes them.
public struct CaptureClient: CaptureAPI {
  private let requester: AuthorizedRequester

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
  }

  // MARK: - Wire types

  private struct CreateUploadBody: Encodable {
    let file_name: String
    let mime_type: String
    let file_size: Int
  }

  private struct CreateUploadReply: Decodable {
    let id: String
    let upload_url: String
    let upload_url_expires_at: String
  }

  private struct FileReply: Decodable {
    let moderation_status: String?
  }

  private struct NotesBody: Encodable {
    let notes: String
  }

  private struct LakeListReply: Decodable {
    struct Lake: Decodable {
      let id: String
      let name: String
      let file_count: Int
      let built_in: Bool
    }
    let data: [Lake]
    let next_cursor: String?
  }

  private struct ErrorReply: Decodable {
    let error: String?
  }

  // MARK: - Operations

  public func createUpload(fileName: String, mimeType: String, byteCount: Int) async throws -> UploadTicket {
    let body = try Self.encode(CreateUploadBody(file_name: fileName, mime_type: mimeType, file_size: byteCount))
    let response = try await requester.send(method: "POST", path: "api/v1/files", jsonBody: body)
    try Self.require(201, response)
    guard let reply = try? JSONDecoder().decode(CreateUploadReply.self, from: response.body),
      let url = URL(string: reply.upload_url),
      let expiresAt = (try? LenientISO8601DateTranscoder().decode(reply.upload_url_expires_at))
    else { throw APIError.malformedResponse }
    return UploadTicket(fileID: reply.id, uploadURL: url, expiresAt: expiresAt)
  }

  public func fileStatus(fileID: String) async throws -> RemoteFileStatus {
    let response = try await requester.send(method: "GET", path: "api/v1/files/\(fileID)")
    try Self.require(200, response)
    guard let reply = try? JSONDecoder().decode(FileReply.self, from: response.body) else {
      throw APIError.malformedResponse
    }
    guard let raw = reply.moderation_status else { return .unscanned }
    return RemoteFileStatus(rawValue: raw) ?? .pending
  }

  public func setNotes(fileID: String, notes: String) async throws {
    let response = try await requester.send(
      method: "PATCH", path: "api/v1/files/\(fileID)", jsonBody: try Self.encode(NotesBody(notes: notes)))
    try Self.require(200, response)
  }

  public func listLakes(cursor: String?, limit: Int) async throws -> Page<LakeSummary> {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    let response = try await requester.send(method: "GET", path: "api/v1/data-lakes", query: query)
    try Self.require(200, response)
    guard let reply = try? JSONDecoder().decode(LakeListReply.self, from: response.body) else {
      throw APIError.malformedResponse
    }
    let lakes = reply.data.map {
      LakeSummary(id: $0.id, name: $0.name, fileCount: $0.file_count, isBuiltIn: $0.built_in)
    }
    return Page(items: lakes, nextCursor: reply.next_cursor)
  }

  public func addFileToLake(lakeID: String, fileID: String) async throws {
    let response = try await requester.send(method: "POST", path: "api/v1/data-lakes/\(lakeID)/files/\(fileID)")
    try Self.require(200, response)
  }

  public func sendSessionMessage(sessionID: String, message: String, fileIDs: [String]) async throws {
    let body = try ChatSendWire.body(
      for: ChatSendRequest(message: message, target: .session(sessionID), fileIDs: fileIDs))
    let response = try await requester.send(method: "POST", path: "api/chat", jsonBody: body)
    if response.status == 400 || response.status == 422 { throw Self.rejection(response) }
    let receipt = try ChatSendWire.receipt(status: response.status, body: response.body)
    if receipt.isRefused { throw CaptureError.turnRefused(message: receipt.message) }
  }

  // MARK: - Helpers

  private static func encode(_ value: some Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try encoder.encode(value)
  }

  private static func require(_ status: Int, _ response: AuthorizedRequester.Response) throws {
    if response.status == status { return }
    if response.status == 400 || response.status == 422 { throw rejection(response) }
    throw APIError(status: response.status)
  }

  private static func rejection(_ response: AuthorizedRequester.Response) -> CaptureError {
    let message = (try? JSONDecoder().decode(ErrorReply.self, from: response.body))?.error
    return .rejected(message: message ?? "The server could not accept this.")
  }
}
