import Foundation

/// A model Studio can offer for one kind of generation.
public struct GenerationModel: Identifiable, Hashable, Sendable {
  public let id: String
  public let name: String
  /// What the model accepts; nil when the list did not describe it (the params panel then shows nothing).
  public let capabilities: ModelCapabilities?

  public init(id: String, name: String, capabilities: ModelCapabilities? = nil) {
    self.id = id
    self.name = name
    self.capabilities = capabilities
  }

  /// The only image models the server accepts `edit_regions` for (`isFlux3ImageModel` in
  /// b4m-core/common/src/utils/modelHelpers.ts). The models list has no capability flag for it.
  public static let regionEditModels: [GenerationModel] = [
    GenerationModel(id: "flux-3-image", name: "FLUX 3"),
    GenerationModel(id: "flux-3-image-klein", name: "FLUX 3 Klein"),
  ]

  /// Used when the models list cannot be loaded.
  public static func fallback(for kind: GenerationKind) -> GenerationModel? {
    kind == .image ? GenerationModel(id: "gpt-image-2", name: "GPT Image 2") : nil
  }
}

/// A text-to-media request from the create bar.
public struct GenerationRequest: Equatable, Sendable {
  public let kind: GenerationKind
  public let prompt: String
  public let modelID: String
  /// Only the values changed from the model defaults; everything else is left to the server.
  public let params: GenerationParams
  /// Images attached as video frames, reference or style; only video requests carry them.
  public let inputs: [GenerationInput]

  public init(
    kind: GenerationKind, prompt: String, modelID: String, params: GenerationParams = GenerationParams(),
    inputs: [GenerationInput] = []
  ) {
    self.kind = kind
    self.prompt = prompt
    self.modelID = modelID
    self.params = params
    self.inputs = inputs
  }
}

/// A region edit of an existing image.
public struct ImageEditRequest: Equatable, Sendable {
  /// The Files entry of the image to edit.
  public let sourceFileID: String
  public let modelID: String
  public let regions: [EditRegion]

  public init(sourceFileID: String, modelID: String, regions: [EditRegion]) {
    self.sourceFileID = sourceFileID
    self.modelID = modelID
    self.regions = regions
  }

  /// The overall prompt the route requires: the region prompts joined, since each box carries its own.
  public var summaryPrompt: String {
    regions.map { $0.prompt.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "; ")
  }
}

/// Where a generation stands on the server, plus what it produced once it succeeded.
public struct GenerationStatus: Equatable, Sendable {
  public let phase: GenerationPhase
  /// Short-lived presigned URLs of the output.
  public let resultURLs: [URL]
  /// The Files entry of a job's output, once it succeeded; nil for outputs stored outside Files.
  public let resultFileID: String?

  public init(phase: GenerationPhase, resultURLs: [URL] = [], resultFileID: String? = nil) {
    self.phase = phase
    self.resultURLs = resultURLs
    self.resultFileID = resultFileID
  }
}

/// Studio's generation routes, all public v1 contracts (so the Android client uses the same ones).
public protocol StudioAPI: Sendable {
  func models(for kind: GenerationKind) async throws -> [GenerationModel]
  /// One handle per job: an image request for several images starts several.
  func generate(_ request: GenerationRequest) async throws -> [GenerationHandle]
  func editImage(_ request: ImageEditRequest) async throws -> GenerationHandle
  /// Starts a Scene: a video and a music track muxed into one clip. Free, so it never refuses for credits.
  func composeScene(_ request: SceneRequest) async throws -> GenerationHandle
  func status(of handle: GenerationHandle) async throws -> GenerationStatus
  func cancel(_ handle: GenerationHandle) async throws
}

/// A request the server refused before starting anything, with its `errorCode` when it sent one.
public struct StudioRequestError: Error, Equatable, Sendable {
  public let status: Int
  public let code: String?
  public let serverMessage: String?

  public var failure: GenerationFailure { GenerationFailure(code: code) }
}
