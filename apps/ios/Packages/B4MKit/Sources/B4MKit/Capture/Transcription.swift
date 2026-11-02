import Foundation

/// Turns a recorded audio file into text.
public protocol TranscriptionService: Sendable {
  func transcribe(audioFile: URL, mimeType: String) async throws -> String
}

public enum TranscriptionError: Error, Equatable, Sendable {
  /// The recording is empty, too long (25 MiB cap) or an unsupported type.
  case unusableRecording
  /// The deployment has no speech model configured.
  case unavailable
  case insufficientCredits
  case failed(message: String)
}

/// Server-side transcription over the public contracts (`transcription.contract.ts`):
/// `POST /api/v1/transcriptions/uploads` mints a presigned S3 POST, the audio is POSTed to it as
/// `multipart/form-data`, then `POST /api/v1/transcriptions` with the `file_key` returns the text.
///
/// The call is synchronous server-side (45 s provider budget), so this suits short voice notes.
public struct TranscriptionClient: TranscriptionService {
  /// 25 MiB, the server's cap (`TRANSCRIPTION_MAX_BYTES`).
  public static let maxBytes = 25 * 1024 * 1024

  private let requester: AuthorizedRequester
  private let transport: any HTTPTransport

  public init(baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport()) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
    self.transport = transport
  }

  private struct UploadRequest: Encodable {
    let mime_type: String
    let file_size: Int
  }

  private struct UploadReply: Decodable {
    let upload_url: String
    let upload_fields: [String: String]
    let file_key: String
  }

  private struct TranscribeRequest: Encodable {
    let file_key: String
  }

  private struct TextReply: Decodable {
    let text: String
  }

  private struct ErrorReply: Decodable {
    let error: String?
    let errorCode: String?
  }

  public func transcribe(audioFile: URL, mimeType: String) async throws -> String {
    let audio = try Data(contentsOf: audioFile)
    guard !audio.isEmpty, audio.count <= Self.maxBytes else { throw TranscriptionError.unusableRecording }

    let mint = try await requester.send(
      method: "POST", path: "api/v1/transcriptions/uploads",
      jsonBody: try JSONEncoder().encode(UploadRequest(mime_type: mimeType, file_size: audio.count)))
    try Self.require(201, mint)
    guard let ticket = try? JSONDecoder().decode(UploadReply.self, from: mint.body),
      let uploadURL = URL(string: ticket.upload_url)
    else { throw APIError.malformedResponse }

    try await upload(audio, fileName: audioFile.lastPathComponent, fields: ticket.upload_fields, to: uploadURL)

    let response = try await requester.send(
      method: "POST", path: "api/v1/transcriptions",
      jsonBody: try JSONEncoder().encode(TranscribeRequest(file_key: ticket.file_key)))
    try Self.require(200, response)
    guard let reply = try? JSONDecoder().decode(TextReply.self, from: response.body) else {
      throw APIError.malformedResponse
    }
    return reply.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Presigned POST: every field first, in the order given, the file last (S3 ignores anything after it).
  private func upload(_ audio: Data, fileName: String, fields: [String: String], to url: URL) async throws {
    let boundary = "b4m-\(UUID().uuidString)"
    var body = Data()
    for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
      body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
    }
    let mime = fields["Content-Type"] ?? "application/octet-stream"
    body.append(
      "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\nContent-Type: \(mime)\r\n\r\n"
    )
    body.append(audio)
    body.append("\r\n--\(boundary)--\r\n")

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    let status: Int
    do {
      status = try await transport.send(request).1.statusCode
    } catch is URLError {
      throw APIError.offline
    }
    guard (200..<300).contains(status) else { throw TranscriptionError.failed(message: "The recording did not upload.") }
  }

  private static func require(_ status: Int, _ response: AuthorizedRequester.Response) throws {
    if response.status == status { return }
    let reply = try? JSONDecoder().decode(ErrorReply.self, from: response.body)
    switch response.status {
    case 422 where reply?.errorCode == "insufficient_credits": throw TranscriptionError.insufficientCredits
    case 422: throw TranscriptionError.unusableRecording
    case 503: throw TranscriptionError.unavailable
    case 502, 504: throw TranscriptionError.failed(message: reply?.error ?? "Transcription failed. Try a shorter note.")
    default: throw APIError(status: response.status)
    }
  }
}

extension Data {
  fileprivate mutating func append(_ string: String) {
    append(Data(string.utf8))
  }
}
