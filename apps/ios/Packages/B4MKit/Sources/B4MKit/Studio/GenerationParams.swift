import Foundation

/// A generation parameter the params panel can set. The raw value is a stable id for persistence, not the wire
/// name: `StudioWire` maps each key onto the request body of its route.
public enum ParamKey: String, CaseIterable, Codable, Sendable {
  case size
  case quality
  case count
  case seed
  case transparentBackground
  case aspectRatio
  case duration
  case resolution
  case audio
  case instrumental
  case lyrics
}

public enum ParamValue: Hashable, Codable, Sendable {
  case text(String)
  case number(Double)
  case flag(Bool)

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let flag = try? container.decode(Bool.self) {
      self = .flag(flag)
    } else if let number = try? container.decode(Double.self) {
      self = .number(number)
    } else {
      self = .text(try container.decode(String.self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .text(let text): try container.encode(text)
    case .number(let number): try container.encode(number)
    case .flag(let flag): try container.encode(flag)
    }
  }

  public var text: String? {
    if case .text(let text) = self { return text }
    return nil
  }

  public var number: Double? {
    if case .number(let number) = self { return number }
    return nil
  }

  public var flag: Bool? {
    if case .flag(let flag) = self { return flag }
    return nil
  }
}

public struct ParamOption: Hashable, Sendable {
  public let value: ParamValue
  public let label: String

  public init(value: ParamValue, label: String) {
    self.value = value
    self.label = label
  }
}

/// One control in the params panel, derived from a model's capabilities. The panel renders by `kind` and never
/// branches on the model.
public struct ParamControl: Identifiable, Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case choice([ParamOption])
    /// Whole steps between the bounds, inclusive.
    case range(min: Double, max: Double, step: Double)
    case toggle
    /// A non-negative integer the person types or rolls.
    case seed
    case text(maxCharacters: Int)
  }

  public let key: ParamKey
  public let title: String
  public let kind: Kind
  /// What the model uses when the value is left alone; nil when the model or provider decides.
  public let defaultValue: ParamValue?

  public var id: ParamKey { key }

  /// The largest seed the providers take (an unsigned 32-bit integer).
  public static let maximumSeed: Double = 4_294_967_295

  public func accepts(_ value: ParamValue) -> Bool {
    switch (kind, value) {
    case (.choice(let options), _): return options.contains { $0.value == value }
    case (.range(let min, let max, let step), .number(let number)):
      guard number >= min, number <= max else { return false }
      let steps = (number - min) / step
      return abs(steps - steps.rounded()) < 0.000_1
    case (.toggle, .flag): return true
    case (.seed, .number(let number)): return number >= 0 && number <= Self.maximumSeed && number == number.rounded()
    case (.text(let maxCharacters), .text(let text)): return text.count <= maxCharacters
    default: return false
    }
  }

  /// A short label for a value, as shown in the summary chip and on a finished item.
  public func label(for value: ParamValue) -> String {
    if case .choice(let options) = kind, let option = options.first(where: { $0.value == value }) {
      return option.label
    }
    switch (key, value) {
    case (.duration, .number(let seconds)): return "\(Self.format(seconds))s"
    case (.count, .number(let count)): return count == 1 ? "1 image" : "\(Self.format(count)) images"
    case (.seed, .number(let seed)): return "seed \(Self.format(seed))"
    case (.transparentBackground, .flag(true)): return "transparent"
    case (.instrumental, .flag(true)): return "instrumental"
    case (.lyrics, .text): return "lyrics"
    case (_, .flag(let flag)): return "\(title.lowercased()) \(flag ? "on" : "off")"
    case (_, .number(let number)): return Self.format(number)
    case (_, .text(let text)): return text
    }
  }

  static func format(_ number: Double) -> String {
    number == number.rounded() ? String(Int(number)) : String(number)
  }
}

/// The values the person changed from the model defaults. Only these are sent, so the server and provider keep
/// deciding everything left alone, exactly as on the web.
public struct GenerationParams: Hashable, Codable, Sendable {
  public private(set) var values: [ParamKey: ParamValue]

  public init(_ values: [ParamKey: ParamValue] = [:]) {
    self.values = values
  }

  public subscript(key: ParamKey) -> ParamValue? {
    get { values[key] }
    set { values[key] = newValue }
  }

  public var isEmpty: Bool { values.isEmpty }

  /// The value a control shows: the person's choice, else the model default.
  public func value(for control: ParamControl) -> ParamValue? {
    values[control.key] ?? control.defaultValue
  }

  /// Sets a value, or clears it when it equals the default so the summary stays honest.
  public mutating func set(_ value: ParamValue?, for control: ParamControl) {
    values[control.key] = value == control.defaultValue ? nil : value
  }

  /// The values the other model also takes, plus the keys that had to go. The caller names the dropped ones.
  public func carried(to capabilities: ModelCapabilities?) -> (params: GenerationParams, dropped: [ParamKey]) {
    var kept = GenerationParams()
    var dropped: [ParamKey] = []
    let controls = ParamControls.controls(for: capabilities, params: self)
    for key in ParamKey.allCases {
      guard let value = values[key] else { continue }
      if let control = controls.first(where: { $0.key == key }), control.accepts(value) {
        kept.values[key] = value == control.defaultValue ? nil : value
      } else {
        dropped.append(key)
      }
    }
    return (kept, dropped)
  }

  /// "16:9 \u{00B7} 8s \u{00B7} 1080p \u{00B7} seed 42" for the changed values, in panel order; nil when nothing changed.
  public func summary(controls: [ParamControl]) -> String? {
    let parts = controls.compactMap { control in values[control.key].map { control.label(for: $0) } }
    return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
  }
}

/// Builds the panel's controls from capabilities. Shared by every platform's renderer in spirit: the Kotlin client
/// mirrors this mapping rather than hard-coding per-model controls.
public enum ParamControls {
  public static func controls(for capabilities: ModelCapabilities?, params: GenerationParams) -> [ParamControl] {
    switch capabilities {
    case .image(let image): imageControls(image)
    case .video(let video): videoControls(video)
    case .music(let music): musicControls(music, instrumental: params[.instrumental]?.flag ?? false)
    case nil: []
    }
  }

  private static func imageControls(_ image: ImageCapabilities) -> [ParamControl] {
    var controls: [ParamControl] = []
    if !image.sizes.isEmpty {
      controls.append(
        ParamControl(
          key: .size, title: "Size", kind: .choice(image.sizes.map { option($0, sizeLabel($0)) }),
          defaultValue: image.defaultSize.map(ParamValue.text)))
    }
    if !image.qualities.isEmpty {
      controls.append(
        ParamControl(
          key: .quality, title: "Quality", kind: .choice(image.qualities.map { option($0, $0.capitalized) }),
          defaultValue: nil))
    }
    if image.maxImages > 1 {
      controls.append(
        ParamControl(
          key: .count, title: "Images", kind: .range(min: 1, max: Double(image.maxImages), step: 1),
          defaultValue: .number(1)))
    }
    if image.transparentBackground {
      controls.append(
        ParamControl(
          key: .transparentBackground, title: "Transparent background", kind: .toggle, defaultValue: .flag(false)))
    }
    if image.seed {
      controls.append(ParamControl(key: .seed, title: "Seed", kind: .seed, defaultValue: nil))
    }
    return controls
  }

  private static func videoControls(_ video: VideoCapabilities) -> [ParamControl] {
    var controls: [ParamControl] = []
    if !video.aspectRatios.isEmpty {
      controls.append(
        ParamControl(
          key: .aspectRatio, title: "Aspect ratio", kind: .choice(video.aspectRatios.map { option($0, $0) }),
          defaultValue: video.defaultAspectRatio.map(ParamValue.text)))
    }
    switch video.duration {
    case .range(let min, let max, let step)?:
      controls.append(
        ParamControl(
          key: .duration, title: "Duration", kind: .range(min: min, max: max, step: step),
          defaultValue: video.defaultDuration.map(ParamValue.number)))
    case .discrete(let values)?:
      controls.append(
        ParamControl(
          key: .duration, title: "Duration",
          kind: .choice(values.map { ParamOption(value: .number($0), label: "\(ParamControl.format($0))s") }),
          defaultValue: video.defaultDuration.map(ParamValue.number)))
    case nil:
      break
    }
    if !video.resolutions.isEmpty {
      controls.append(
        ParamControl(
          key: .resolution, title: "Resolution", kind: .choice(video.resolutions.map { option($0, $0) }),
          defaultValue: video.defaultResolution.map(ParamValue.text)))
    }
    if video.audio == .optional {
      // The provider picks when audio is left alone, so there is no default to show.
      controls.append(
        ParamControl(
          key: .audio, title: "Audio",
          kind: .choice([
            ParamOption(value: .flag(true), label: "With audio"), ParamOption(value: .flag(false), label: "Silent"),
          ]),
          defaultValue: nil))
    }
    return controls
  }

  private static func musicControls(_ music: MusicCapabilities, instrumental: Bool) -> [ParamControl] {
    var controls: [ParamControl] = []
    if case .adjustable(let min, let max, let defaultSeconds, _)? = music.duration {
      controls.append(
        ParamControl(
          key: .duration, title: "Duration", kind: .range(min: Double(min), max: Double(max), step: 1),
          defaultValue: .number(Double(defaultSeconds))))
    }
    if music.vocals {
      controls.append(
        ParamControl(key: .instrumental, title: "Instrumental", kind: .toggle, defaultValue: .flag(false)))
      // The server refuses lyrics on an instrumental (`lyrics_with_instrumental`).
      if let maxCharacters = music.lyricsMaxChars, !instrumental {
        controls.append(
          ParamControl(key: .lyrics, title: "Lyrics", kind: .text(maxCharacters: maxCharacters), defaultValue: nil))
      }
    }
    return controls
  }

  private static func option(_ value: String, _ label: String) -> ParamOption {
    ParamOption(value: .text(value), label: label)
  }

  private static func sizeLabel(_ size: String) -> String {
    size.replacingOccurrences(of: "x", with: "\u{00D7}")
  }
}

/// The credits a generation is expected to cost, from the same pricing the model lists advertise. Nil when the
/// list carries no price for it (images today: `GET /api/v1/models` has no image pricing).
public enum CreditEstimate {
  public static func credits(for capabilities: ModelCapabilities?, params: GenerationParams) -> Int? {
    switch capabilities {
    case .video(let video):
      guard let rates = video.creditsPerSecond else { return nil }
      let resolution = params[.resolution]?.text ?? video.defaultResolution ?? video.resolutions.first
      guard let resolution, let rate = rates[resolution],
        let seconds = params[.duration]?.number ?? video.defaultDuration
      else { return nil }
      return Int((rate * seconds).rounded(.up))
    case .music(let music):
      guard let pricing = music.pricing else { return nil }
      switch pricing.unit {
      case .perSong: return Int(pricing.credits.rounded(.up))
      case .perSecond:
        let seconds: Double
        switch music.duration {
        case .adjustable(_, _, let defaultSeconds, _)?: seconds = params[.duration]?.number ?? Double(defaultSeconds)
        case .fixed(let fixed)?: seconds = Double(fixed)
        case nil: return nil
        }
        return Int((pricing.credits * seconds).rounded(.up))
      }
    case .image, nil:
      return nil
    }
  }
}
