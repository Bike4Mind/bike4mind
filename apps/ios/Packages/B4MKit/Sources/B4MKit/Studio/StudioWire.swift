import Foundation

/// Hand-written wire format for Studio's public v1 routes. Keep in sync with the contracts in
/// b4m-core/common/src/api-contract/contracts (image generation and edit, video, music, models, quest poll,
/// session create) and `GenerationJobUpdatedAction` in b4m-core/common/src/schemas/actions.ts.
/// Hand-written rather than generated because the committed OpenAPI snapshot predates `edit_regions`.
enum StudioWire {
  static let imageGenerationsPath = "api/v1/image-generations"
  static let imageEditsPath = "api/v1/image-edits"
  static let sessionsPath = "api/v1/sessions"
  static let modelsPath = "api/v1/models"

  static func jobsPath(_ kind: GenerationKind) -> String {
    kind == .video ? "api/v1/video-generations" : "api/v1/music-generations"
  }

  static func modelsPath(_ kind: GenerationKind) -> String {
    switch kind {
    case .image: modelsPath
    case .video: "api/v1/video-models"
    case .music: "api/v1/music-models"
    }
  }

  static func safeID(_ id: String) throws -> String {
    guard DeepLinkRouter.isValidIdentifier(id) else { throw APIError.notFound }
    return id
  }

  // MARK: Requests

  /// Encodes as `null`, which every Studio route reads as "bill my personal credits". Leaving the key out
  /// is not the same: the server then bills the account's home organization (`resolveBillingOrgId` in
  /// packages/server-utils/src/utils/orgAccess.ts), which can be an empty org.
  struct PersonalBilling: Encodable {
    func encode(to encoder: any Encoder) throws {
      var container = encoder.singleValueContainer()
      try container.encodeNil()
    }
  }

  struct ImageGenerationBody: Encodable {
    let prompt: String
    let model: String
    let n = 1
    /// The create bar has no conversation for the server to resolve a follow-up against.
    let promptResolution = "literal"
    let organizationID = PersonalBilling()

    enum CodingKeys: String, CodingKey {
      case prompt, model, n
      case promptResolution = "prompt_resolution"
      case organizationID = "organization_id"
    }
  }

  struct ImageEditBody: Encodable {
    struct Region: Encodable {
      let prompt: String
      let bbox: [Double]
    }
    let prompt: String
    let model: String
    let sessionId: String
    let image: String
    let editRegions: [Region]
    let organizationID = PersonalBilling()

    enum CodingKeys: String, CodingKey {
      case prompt, model, sessionId, image
      case editRegions = "edit_regions"
      case organizationID = "organization_id"
    }
  }

  /// Video and music bodies are strict on the server: an unknown key is a 422, so only declared keys go.
  struct JobBody: Encodable {
    let model: String
    let prompt: String
    let instrumental: Bool?
    let organizationID = PersonalBilling()

    enum CodingKeys: String, CodingKey {
      case model, prompt, instrumental
      case organizationID = "organization_id"
    }
  }

  struct SessionBody: Encodable {
    let name: String
  }

  static func encode(_ value: some Encodable) throws -> Data {
    try JSONEncoder().encode(value)
  }

  // MARK: Responses

  struct ImageGenerationReply: Decodable {
    struct Quest: Decodable { let id: String }
    let quest: Quest
  }

  struct QuestReply: Decodable {
    let id: String
  }

  struct QuestPoll: Decodable {
    struct File: Decodable {
      let url: String?
      let isImage: Bool?
    }
    let status: String?
    let type: String?
    let errorCode: String?
    let files: [File]?
  }

  struct Job: Decodable {
    struct Failure: Decodable { let code: String? }
    struct Output: Decodable {
      let availability: String?
      let url: String?
    }
    let id: String
    let state: String
    let progress: Double?
    let error: Failure?
    let output: Output?
  }

  struct ErrorEnvelope: Decodable {
    let error: String?
    let errorCode: String?
  }

  struct SessionReply: Decodable {
    let id: String?
    let _id: String?
  }

  struct ImageModelsPage: Decodable {
    struct Model: Decodable {
      let id: String
      let name: String?
      let type: String?
      let deprecationDate: String?

      enum CodingKeys: String, CodingKey {
        case id, name, type
        case deprecationDate = "deprecation_date"
      }
    }
    let data: [Model]
    let nextCursor: String?

    enum CodingKeys: String, CodingKey {
      case data
      case nextCursor = "next_cursor"
    }
  }

  struct JobModels: Decodable {
    struct Model: Decodable {
      let id: String
      let displayName: String?
      let modes: [String]?
      let deprecationDate: String?

      enum CodingKeys: String, CodingKey {
        case id, modes
        case displayName = "display_name"
        case deprecationDate = "deprecation_date"
      }
    }
    let models: [Model]
  }

  static func decode<T: Decodable>(_ type: T.Type, from body: Data) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: body)
    } catch {
      throw APIError.malformedResponse
    }
  }

  /// A refused create: the server's `errorCode` when it sent one, else the plain status mapping.
  static func refusal(status: Int, body: Data) -> any Error {
    switch status {
    case 400, 402, 409, 422:
      let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body)
      return StudioRequestError(status: status, code: envelope?.errorCode, serverMessage: envelope?.error)
    default:
      return APIError(status: status)
    }
  }

  // MARK: Status mapping

  /// `GENERATION_JOB_STATES` (b4m-core/common/src/types/entities/GenerationJobTypes.ts). A succeeded job whose
  /// output is still being scanned is not finished yet: the URL arrives once the scan clears.
  static func phase(jobState: String, progress: Double?, errorCode: String?, availability: String?) -> GenerationPhase {
    switch jobState {
    case "pending": return .queued
    case "running", "storing": return .running(progress: progress)
    case "succeeded":
      switch availability {
      case "unavailable": return .failed(.other(code: "output_unavailable"))
      case "pending_scan": return .running(progress: 1)
      default: return .succeeded
      }
    case "blocked": return .failed(.blocked)
    case "cancelled": return .cancelled
    case "failed": return .failed(GenerationFailure(code: errorCode))
    default: return .running(progress: progress)
    }
  }

  static func status(of job: Job) -> GenerationStatus {
    let phase = phase(
      jobState: job.state, progress: job.progress, errorCode: job.error?.code, availability: job.output?.availability)
    let urls = phase == .succeeded ? [job.output?.url].compactMap { $0.flatMap(URL.init(string:)) } : []
    return GenerationStatus(phase: phase, resultURLs: urls)
  }

  /// A quest `stopped`, or `type: "error"`, is a failure even with a 200; `errorCode` is set only for credit
  /// refusals.
  static func status(of quest: QuestPoll) -> GenerationStatus {
    if quest.type == "error" || quest.status == "stopped" {
      return GenerationStatus(phase: .failed(GenerationFailure(code: quest.errorCode)))
    }
    guard quest.status == "done" else {
      return GenerationStatus(phase: quest.status == "running" ? .running(progress: nil) : .queued)
    }
    let urls = (quest.files ?? []).filter { $0.isImage ?? true }.compactMap { $0.url.flatMap(URL.init(string:)) }
    guard !urls.isEmpty else { return GenerationStatus(phase: .failed(.other(code: "no_output"))) }
    return GenerationStatus(phase: .succeeded, resultURLs: urls)
  }
}

/// The realtime `generation_job_updated` frame. It carries no URL, so a success still needs a fetch.
struct GenerationJobFrame: Equatable {
  static let action = "generation_job_updated"

  let jobID: String
  let status: GenerationStatus

  init?(_ frame: ActionFrame) {
    guard frame.action == Self.action, let job = frame.payload["job"]?.objectValue,
      let id = job["id"]?.stringValue, let state = job["state"]?.stringValue
    else { return nil }
    jobID = id
    // A success frame has no URL or scan state; report it as nearly done and let the fetch finish it.
    let phase =
      state == "succeeded"
      ? .running(progress: 1)
      : StudioWire.phase(
        jobState: state, progress: job["progress"]?.numberValue,
        errorCode: job["error"]?.objectValue?["code"]?.stringValue, availability: nil)
    status = GenerationStatus(phase: phase)
  }

  var needsFetch: Bool { status.phase == .running(progress: 1) }
}

/// `StudioAPI` over `AuthorizedRequester`: bearer, one 401 retry, failures folded into `APIError`.
public struct StudioClient: StudioAPI {
  private let requester: AuthorizedRequester
  private let now: @Sendable () -> Date

  public init(
    baseURL: URL, tokens: any AccessTokenProviding, transport: any HTTPTransport = URLSessionTransport(),
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    requester = AuthorizedRequester(baseURL: baseURL, tokens: tokens, transport: transport)
    self.now = now
  }

  /// Bounds the image model listing; it is paged with no type filter.
  static let maximumModelPages = 10

  public func models(for kind: GenerationKind) async throws -> [GenerationModel] {
    switch kind {
    case .image:
      var models: [GenerationModel] = []
      var cursor: String?
      for _ in 0..<Self.maximumModelPages {
        var query = [URLQueryItem(name: "limit", value: "100")]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        let response = try await requester.send(method: "GET", path: StudioWire.modelsPath, query: query)
        guard response.status == 200 else { throw APIError(status: response.status) }
        let page = try StudioWire.decode(StudioWire.ImageModelsPage.self, from: response.body)
        models += page.data.filter { $0.type == "image" && $0.deprecationDate == nil }
          .map { GenerationModel(id: $0.id, name: $0.name ?? $0.id) }
        guard let next = page.nextCursor, !next.isEmpty else { break }
        cursor = next
      }
      return models
    case .video, .music:
      let response = try await requester.send(method: "GET", path: StudioWire.modelsPath(kind))
      guard response.status == 200 else { throw APIError(status: response.status) }
      return try StudioWire.decode(StudioWire.JobModels.self, from: response.body).models
        .filter { $0.deprecationDate == nil && (kind == .music || ($0.modes ?? []).contains("text_to_video")) }
        .map { GenerationModel(id: $0.id, name: $0.displayName ?? $0.id) }
    }
  }

  public func generate(_ request: GenerationRequest) async throws -> GenerationHandle {
    let startedAt = now()
    switch request.kind {
    case .image:
      let body = try StudioWire.encode(StudioWire.ImageGenerationBody(prompt: request.prompt, model: request.modelID))
      let response = try await requester.send(method: "POST", path: StudioWire.imageGenerationsPath, jsonBody: body)
      guard response.status == 200 else { throw StudioWire.refusal(status: response.status, body: response.body) }
      let reply = try StudioWire.decode(StudioWire.ImageGenerationReply.self, from: response.body)
      return GenerationHandle(kind: .image, id: reply.quest.id, prompt: request.prompt, startedAt: startedAt)
    case .video, .music:
      let body = try StudioWire.encode(
        StudioWire.JobBody(
          model: request.modelID, prompt: request.prompt,
          instrumental: request.kind == .music && request.instrumental ? true : nil))
      let response = try await requester.send(method: "POST", path: StudioWire.jobsPath(request.kind), jsonBody: body)
      guard response.status == 202 || response.status == 200 else {
        throw StudioWire.refusal(status: response.status, body: response.body)
      }
      let job = try StudioWire.decode(StudioWire.Job.self, from: response.body)
      return GenerationHandle(kind: request.kind, id: job.id, prompt: request.prompt, startedAt: startedAt)
    }
  }

  public func editImage(_ request: ImageEditRequest) async throws -> GenerationHandle {
    let body = try StudioWire.encode(
      StudioWire.ImageEditBody(
        prompt: request.summaryPrompt, model: request.modelID, sessionId: request.sessionID,
        image: request.imageURL.absoluteString,
        editRegions: request.regions.map { .init(prompt: $0.prompt, bbox: $0.bbox) }))
    let startedAt = now()
    let response = try await requester.send(method: "POST", path: StudioWire.imageEditsPath, jsonBody: body)
    guard response.status == 200 else { throw StudioWire.refusal(status: response.status, body: response.body) }
    let quest = try StudioWire.decode(StudioWire.QuestReply.self, from: response.body)
    return GenerationHandle(kind: .image, id: quest.id, prompt: request.summaryPrompt, startedAt: startedAt)
  }

  public func status(of handle: GenerationHandle) async throws -> GenerationStatus {
    let id = try StudioWire.safeID(handle.id)
    switch handle.kind {
    case .image:
      let response = try await requester.send(method: "GET", path: "api/v1/quests/\(id)")
      guard response.status == 200 else { throw APIError(status: response.status) }
      return StudioWire.status(of: try StudioWire.decode(StudioWire.QuestPoll.self, from: response.body))
    case .video, .music:
      let response = try await requester.send(method: "GET", path: "\(StudioWire.jobsPath(handle.kind))/\(id)")
      guard response.status == 200 else { throw APIError(status: response.status) }
      return StudioWire.status(of: try StudioWire.decode(StudioWire.Job.self, from: response.body))
    }
  }

  public func cancel(_ handle: GenerationHandle) async throws {
    guard handle.isCancellable else { return }
    let id = try StudioWire.safeID(handle.id)
    let response = try await requester.send(method: "POST", path: "\(StudioWire.jobsPath(handle.kind))/\(id)/cancel")
    guard response.status == 200 else { throw StudioWire.refusal(status: response.status, body: response.body) }
  }

  public func createSession(name: String) async throws -> String {
    let body = try StudioWire.encode(StudioWire.SessionBody(name: name))
    let response = try await requester.send(method: "POST", path: StudioWire.sessionsPath, jsonBody: body)
    guard response.status == 200 || response.status == 201 else { throw APIError(status: response.status) }
    let reply = try StudioWire.decode(StudioWire.SessionReply.self, from: response.body)
    guard let id = reply.id ?? reply._id else { throw APIError.malformedResponse }
    return id
  }
}
