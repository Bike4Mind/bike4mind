import Foundation

/// What one model accepts, as advertised by the public v1 model lists: the `image` block of `GET /api/v1/models`
/// (`PublicImageCapabilitiesSchema`, b4m-core/common/src/schemas/publicModel.ts), `GET /api/v1/video-models` and
/// `GET /api/v1/music-models` (`toPublicVideoModel` / `toPublicMusicModel` in packages/server-utils). Those read the
/// same catalogs (`IMAGE_MODEL_CATALOG`, `VIDEO_MODEL_CATALOG`, `MUSIC_MODEL_CATALOG`) the web Studio forms and the
/// server's request validation use, so a control built from them offers only values the server accepts.
public enum ModelCapabilities: Hashable, Sendable {
  case image(ImageCapabilities)
  case video(VideoCapabilities)
  case music(MusicCapabilities)
}

public struct ImageCapabilities: Hashable, Sendable {
  /// Accepted `size` values; empty when the model takes no `size` (aspect-ratio, input-image or fixed sizing).
  public let sizes: [String]
  public let defaultSize: String?
  public let qualities: [String]
  public let maxImages: Int
  public let seed: Bool
  public let transparentBackground: Bool
  public let maxReferenceImages: Int
  public let edit: Bool
  public let requiresInputImage: Bool

  public init(
    sizes: [String] = [], defaultSize: String? = nil, qualities: [String] = [], maxImages: Int = 1,
    seed: Bool = false, transparentBackground: Bool = false, maxReferenceImages: Int = 0, edit: Bool = false,
    requiresInputImage: Bool = false
  ) {
    self.sizes = sizes
    self.defaultSize = defaultSize
    self.qualities = qualities
    self.maxImages = maxImages
    self.seed = seed
    self.transparentBackground = transparentBackground
    self.maxReferenceImages = maxReferenceImages
    self.edit = edit
    self.requiresInputImage = requiresInputImage
  }
}

/// A model's duration control: any multiple of `step` within the bounds, or one of a fixed set.
public enum DurationRule: Hashable, Sendable {
  case range(min: Double, max: Double, step: Double)
  case discrete([Double])
}

public enum AudioSupport: String, Hashable, Sendable {
  case always, optional, none
}

public struct VideoCapabilities: Hashable, Sendable {
  public let modes: [String]
  /// Input role to the most files the model takes for it (`first_frame`, `last_frame`, `reference`, `style`).
  public let inputRoles: [String: Int]
  public let duration: DurationRule?
  public let aspectRatios: [String]
  public let resolutions: [String]
  public let defaultDuration: Double?
  public let defaultAspectRatio: String?
  public let defaultResolution: String?
  public let audio: AudioSupport
  /// Credits per second of output, by resolution; nil when the model is priced per clip.
  public let creditsPerSecond: [String: Double]?

  public init(
    modes: [String] = ["text_to_video"], inputRoles: [String: Int] = [:], duration: DurationRule? = nil,
    aspectRatios: [String] = [], resolutions: [String] = [], defaultDuration: Double? = nil,
    defaultAspectRatio: String? = nil, defaultResolution: String? = nil, audio: AudioSupport = .none,
    creditsPerSecond: [String: Double]? = nil
  ) {
    self.modes = modes
    self.inputRoles = inputRoles
    self.duration = duration
    self.aspectRatios = aspectRatios
    self.resolutions = resolutions
    self.defaultDuration = defaultDuration
    self.defaultAspectRatio = defaultAspectRatio
    self.defaultResolution = defaultResolution
    self.audio = audio
    self.creditsPerSecond = creditsPerSecond
  }
}

public enum MusicDuration: Hashable, Sendable {
  /// `exact` is false for models that treat the length as a target they may miss by a few seconds.
  case adjustable(min: Int, max: Int, defaultSeconds: Int, exact: Bool)
  case fixed(seconds: Int)
}

public struct MusicPricing: Hashable, Sendable {
  public enum Unit: String, Hashable, Sendable {
    case perSong = "per_song"
    case perSecond = "per_second"
  }
  public let unit: Unit
  public let credits: Double

  public init(unit: Unit, credits: Double) {
    self.unit = unit
    self.credits = credits
  }
}

public struct MusicCapabilities: Hashable, Sendable {
  /// False when the model only makes instrumentals (`vocals: "never"`).
  public let vocals: Bool
  /// Most lyric characters accepted; nil when the model takes no lyrics.
  public let lyricsMaxChars: Int?
  public let duration: MusicDuration?
  public let pricing: MusicPricing?

  public init(
    vocals: Bool = true, lyricsMaxChars: Int? = nil, duration: MusicDuration? = nil, pricing: MusicPricing? = nil
  ) {
    self.vocals = vocals
    self.lyricsMaxChars = lyricsMaxChars
    self.duration = duration
    self.pricing = pricing
  }
}
