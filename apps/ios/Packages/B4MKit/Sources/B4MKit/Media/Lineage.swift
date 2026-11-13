import Foundation

/// How a parent file was used to make a child. The server's role list grows over time, so an unknown value is
/// kept as `.other` and shown as a plain "made from" rather than failing the decode.
public enum LineageRole: Hashable, Sendable {
  case firstFrame, lastFrame, reference, style
  case extendOf, variationOf, editSource, mask
  case other(String)

  public init(wire: String) {
    switch wire {
    case "first_frame": self = .firstFrame
    case "last_frame": self = .lastFrame
    case "reference": self = .reference
    case "style": self = .style
    case "extend_of": self = .extendOf
    case "variation_of": self = .variationOf
    case "edit_source": self = .editSource
    case "mask": self = .mask
    default: self = .other(wire)
    }
  }

  /// The video input role this maps to, when the parent was a video input image.
  public var videoInputRole: VideoInputRole? {
    switch self {
    case .firstFrame: .firstFrame
    case .lastFrame: .lastFrame
    case .reference: .reference
    case .style: .style
    default: nil
    }
  }

  public var title: String {
    switch self {
    case .firstFrame: "Start frame"
    case .lastFrame: "End frame"
    case .reference: "Reference"
    case .style: "Style"
    case .extendOf: "Extended from"
    case .variationOf: "Variation of"
    case .editSource: "Edited from"
    case .mask: "Mask"
    case .other: "Made from"
    }
  }
}

/// One file on a trail. An ancestor the person cannot read is `isRedacted`: only its id is known.
public struct LineageNode: Identifiable, Hashable, Sendable {
  public let id: String
  public let isRedacted: Bool
  public let kind: MediaKind?
  public let fileName: String
  public let mimeType: String
  /// `image`, `video`, `music`... as the server records it; nil for a file that was not generated.
  public let generator: String?
  public let modelID: String?
  public let prompt: String?
  public let url: URL?
  public let createdAt: Date?
  /// The stored generation request (camelCase keys), for Branch.
  public let request: JSONObject?

  public init(
    id: String, isRedacted: Bool = false, kind: MediaKind? = nil, fileName: String = "", mimeType: String = "",
    generator: String? = nil, modelID: String? = nil, prompt: String? = nil, url: URL? = nil,
    createdAt: Date? = nil, request: JSONObject? = nil
  ) {
    self.id = id
    self.isRedacted = isRedacted
    self.kind = kind
    self.fileName = fileName
    self.mimeType = mimeType
    self.generator = generator
    self.modelID = modelID
    self.prompt = prompt
    self.url = url
    self.createdAt = createdAt
    self.request = request
  }

  /// The gallery item for this node, nil when it is redacted or not media.
  public var mediaItem: MediaItem? {
    guard !isRedacted, let kind else { return nil }
    return MediaItem(
      id: id, kind: kind, fileName: fileName, mimeType: mimeType, createdAt: createdAt ?? .distantPast, url: url,
      prompt: prompt)
  }
}

public struct LineageEdge: Hashable, Sendable {
  public let parentID: String
  public let childID: String
  public let role: LineageRole

  public init(parentID: String, childID: String, role: LineageRole) {
    self.parentID = parentID
    self.childID = childID
    self.role = role
  }
}

/// A node reached from the open file, with the role that links them.
public struct LineageLink: Identifiable, Hashable, Sendable {
  public let node: LineageNode
  public let role: LineageRole
  public var id: String { "\(role.title):\(node.id)" }
}

/// The trail around one file, as `GET /api/v1/files/{id}/lineage` returns it.
public struct FileLineage: Equatable, Sendable {
  public let fileID: String
  /// The file itself first, then its ancestors by depth.
  public let ancestors: [LineageNode]
  public let children: [LineageNode]
  public let edges: [LineageEdge]
  public let truncated: Bool

  public init(
    fileID: String, ancestors: [LineageNode], children: [LineageNode], edges: [LineageEdge], truncated: Bool = false
  ) {
    self.fileID = fileID
    self.ancestors = ancestors
    self.children = children
    self.edges = edges
    self.truncated = truncated
  }

  public var root: LineageNode? { ancestors.first { $0.id == fileID } }

  /// The direct parents, one link per edge, in edge order.
  public var madeFrom: [LineageLink] {
    edges.filter { $0.childID == fileID }.compactMap { edge in
      ancestors.first { $0.id == edge.parentID }.map { LineageLink(node: $0, role: edge.role) }
    }
  }

  /// The direct children, newest first.
  public var madeInto: [LineageLink] {
    children.map { child in
      let role = edges.first { $0.childID == child.id && $0.parentID == fileID }?.role ?? .other("")
      return LineageLink(node: child, role: role)
    }
  }

  public var isEmpty: Bool { madeFrom.isEmpty && madeInto.isEmpty }
}

/// Loads the trail for the open file. A failure leaves the chips out rather than blocking the detail view.
@MainActor
@Observable
public final class LineageViewModel {
  public enum State: Equatable, Sendable {
    case idle, loading, loaded(FileLineage), failed
  }

  public private(set) var state: State = .idle
  @ObservationIgnored private let api: any MediaAPI
  @ObservationIgnored private let fileID: String

  public init(fileID: String, api: any MediaAPI) {
    self.fileID = fileID
    self.api = api
  }

  public var lineage: FileLineage? {
    if case .loaded(let lineage) = state { return lineage }
    return nil
  }

  public func load() async {
    guard state != .loading else { return }
    state = .loading
    do {
      state = .loaded(try await api.lineage(of: fileID))
    } catch {
      state = .failed
    }
  }
}

public enum LineageBranch {
  /// What a request key means as a params-panel value. Keys a kind does not use are skipped.
  static func params(from request: JSONObject, kind: GenerationKind) -> GenerationParams {
    var params = GenerationParams()
    func number(_ key: String) -> Double? { request[key]?.numberValue }
    func text(_ key: String) -> String? { request[key]?.stringValue }
    switch kind {
    case .image:
      if let size = text("size") { params[.size] = .text(size) }
      if let quality = text("quality") { params[.quality] = .text(quality) }
      if let count = number("n") { params[.count] = .number(count) }
      if let seed = number("seed") { params[.seed] = .number(seed) }
      if text("background") == "transparent" { params[.transparentBackground] = .flag(true) }
    case .video:
      if let duration = number("durationSeconds") { params[.duration] = .number(duration) }
      if let ratio = text("aspectRatio") { params[.aspectRatio] = .text(ratio) }
      if let resolution = text("resolution") { params[.resolution] = .text(resolution) }
      if let audio = request["audio"]?.boolValue { params[.audio] = .flag(audio) }
    case .music:
      if let duration = number("durationSeconds") { params[.duration] = .number(duration) }
      if request["instrumental"]?.boolValue == true { params[.instrumental] = .flag(true) }
      if let lyrics = text("lyrics"), !lyrics.isEmpty { params[.lyrics] = .text(lyrics) }
    }
    return params
  }

  /// Retries a node with its own settings: same kind, model, prompt, values and input images, all editable in the
  /// create bar. nil when the node was not generated by something Studio can run (an upload, a redacted file).
  /// `parents` are the node's direct parents; only video input roles carry over.
  public static func seed(for node: LineageNode, parents: [LineageLink]) -> StudioSeed? {
    guard !node.isRedacted, let kind = node.generator.flatMap(Self.kind(forGenerator:)) else { return nil }
    let inputs: [StudioInput] =
      kind == .video
      ? parents.compactMap { link in
        guard let role = link.role.videoInputRole, let item = link.node.mediaItem, item.kind == .image else {
          return nil
        }
        return StudioInput(role: role, item: item)
      } : []
    return StudioSeed(
      kind: kind, prompt: node.prompt ?? "", inputs: inputs,
      params: params(from: node.request ?? [:], kind: kind), modelID: node.modelID)
  }

  static func kind(forGenerator generator: String) -> GenerationKind? {
    switch generator {
    case "image": .image
    case "video": .video
    case "music": .music
    default: nil
    }
  }
}
