import Foundation

/// What a source image is for in a video request: the wire role names of `VIDEO_INPUT_ROLES`
/// (b4m-core/common/src/video/types.ts).
public enum VideoInputRole: String, CaseIterable, Hashable, Sendable {
  case firstFrame = "first_frame"
  case lastFrame = "last_frame"
  case reference
  case style

  public var title: String {
    switch self {
    case .firstFrame: "Start"
    case .lastFrame: "End"
    case .reference: "Reference"
    case .style: "Style"
    }
  }
}

/// An image attached to the create bar, tagged with the role it plays in the request.
public struct StudioInput: Identifiable, Hashable, Sendable {
  public let role: VideoInputRole
  public let item: MediaItem

  public var id: String { "\(role.rawValue):\(item.id)" }

  public init(role: VideoInputRole, item: MediaItem) {
    self.role = role
    self.item = item
  }
}

/// One attachment as the request carries it: a Files entry id and the role it plays.
public struct GenerationInput: Hashable, Sendable {
  public let role: String
  public let fileID: String

  public init(role: String, fileID: String) {
    self.role = role
    self.fileID = fileID
  }
}

/// What "Turn into..." hands the create bar: a kind, a prefilled prompt and the attached material. Every field
/// stays editable once applied. Lineage chips and describe-for-medium drafts later extend this value rather than
/// the bar.
public struct StudioSeed: Equatable, Sendable {
  public let kind: GenerationKind
  public let prompt: String
  public let inputs: [StudioInput]
  public let params: GenerationParams
  /// The model to select when it is still offered (Branch); nil keeps the bar's choice.
  public let modelID: String?

  public init(
    kind: GenerationKind, prompt: String, inputs: [StudioInput], params: GenerationParams = .init(),
    modelID: String? = nil
  ) {
    self.kind = kind
    self.prompt = prompt
    self.inputs = inputs
    self.params = params
    self.modelID = modelID
  }
}

/// A "Turn into..." target. Cases that need server work (scoring or soundtracking, lineage) are absent until the
/// routes exist.
public enum TurnIntoAction: Hashable, Sendable {
  /// Image to video: the image is the first frame.
  case animate
  /// Image to video: the image is the last frame; the person adds the first (or keeps one already attached).
  case arriveAt
  /// Two images to video: the source is the first frame, a picked image the last.
  case morph
  /// Video to image: a frame is grabbed and then edited.
  case grabFrame

  public var title: String {
    switch self {
    case .animate: "Animate"
    case .arriveAt: "Arrive at this"
    case .morph: "Morph into another image"
    case .grabFrame: "Grab a frame"
    }
  }

  public var systemImage: String {
    switch self {
    case .animate: "play.rectangle"
    case .arriveAt: "flag.checkered"
    case .morph: "arrow.triangle.merge"
    case .grabFrame: "camera.viewfinder"
    }
  }

  /// The kind the action leads to.
  public var targetKind: MediaKind {
    self == .grabFrame ? .image : .video
  }
}

public enum TurnInto {
  /// The actions a finished item offers. Audio has none yet.
  public static func actions(for item: MediaItem) -> [TurnIntoAction] {
    switch item.kind {
    case .image: [.animate, .arriveAt, .morph]
    case .video: [.grabFrame]
    case .audio: []
    }
  }

  /// The seed for an image action. `current` is what the bar already holds: "Arrive at" keeps an attached start
  /// frame, and any other action replaces the frames while keeping reference and style images.
  public static func seed(
    _ action: TurnIntoAction, from item: MediaItem, secondImage: MediaItem? = nil, current: [StudioInput] = []
  ) -> StudioSeed? {
    guard item.kind == .image else { return nil }
    let prompt = item.prompt ?? ""
    let kept = current.filter { $0.role == .reference || $0.role == .style }
    let frames = current.filter { $0.role == .firstFrame || $0.role == .lastFrame }
    switch action {
    case .animate:
      return StudioSeed(
        kind: .video, prompt: prompt, inputs: [StudioInput(role: .firstFrame, item: item)] + kept)
    case .arriveAt:
      let start = frames.filter { $0.role == .firstFrame }
      return StudioSeed(
        kind: .video, prompt: prompt, inputs: start + [StudioInput(role: .lastFrame, item: item)] + kept)
    case .morph:
      guard let secondImage, secondImage.kind == .image, secondImage.id != item.id else { return nil }
      return StudioSeed(
        kind: .video, prompt: prompt,
        inputs: [StudioInput(role: .firstFrame, item: item), StudioInput(role: .lastFrame, item: secondImage)] + kept)
    case .grabFrame:
      return nil
    }
  }
}
