import Foundation
import Observation

/// How the soundtrack is fitted to the video: `SCENE_AUDIO_FITS` (b4m-core/common/src/scene/index.ts).
public enum SceneAudioFit: String, CaseIterable, Hashable, Sendable {
  /// Cut the music where the video ends.
  case trim
  /// Repeat the music until the video ends.
  case loop

  public var title: String {
    switch self {
    case .trim: "Trim to fit"
    case .loop: "Loop to fit"
    }
  }
}

/// A Scene as the compose route takes it: one video, one music track, and how to fit them.
public struct SceneRequest: Equatable, Sendable {
  public let videoFileID: String
  public let audioFileID: String
  public let fit: SceneAudioFit
  /// Nil leaves the fade to the server's default.
  public let fadeInSeconds: Double?
  public let fadeOutSeconds: Double?
  public let coverFileID: String?
  public let title: String?
  /// What the progress tile shows: the title, else the two parts it is made from.
  public let label: String

  public init(
    videoFileID: String, audioFileID: String, fit: SceneAudioFit = .trim,
    fadeInSeconds: Double? = nil, fadeOutSeconds: Double? = nil, coverFileID: String? = nil, title: String? = nil,
    label: String = "Scene"
  ) {
    self.videoFileID = videoFileID
    self.audioFileID = audioFileID
    self.fit = fit
    self.fadeInSeconds = fadeInSeconds
    self.fadeOutSeconds = fadeOutSeconds
    self.coverFileID = coverFileID
    self.title = title
    self.label = label
  }
}

/// The Scene sheet's choices. Pure, so the request it builds is testable without a view.
/// An untouched sheet trims the music and sends no fade, so the server's own defaults apply.
public struct SceneDraft: Equatable, Sendable {
  /// `SCENE_TITLE_MAX_LENGTH`; the server counts UTF-16 code units, so the draft does too.
  public static let maximumTitleLength = 200

  public var video: MediaItem?
  public var audio: MediaItem?
  public var cover: MediaItem?
  public var fit: SceneAudioFit = .trim
  /// On leaves the fade to the server; off sends a zero fade-in and fade-out.
  public var fades = true
  public var title = ""

  public init(
    video: MediaItem? = nil, audio: MediaItem? = nil, cover: MediaItem? = nil, fit: SceneAudioFit = .trim,
    fades: Bool = true, title: String = ""
  ) {
    self.video = video
    self.audio = audio
    self.cover = cover
    self.fit = fit
    self.fades = fades
    self.title = title
  }

  /// A draft that starts from one finished item: a video waits for music, music for a video. Nil for an image.
  public static func starting(from item: MediaItem) -> SceneDraft? {
    switch item.kind {
    case .video: SceneDraft(video: item)
    case .audio: SceneDraft(audio: item)
    case .image: nil
    }
  }

  /// The slot the person still has to fill, from the item the draft started with.
  public var partnerKind: MediaKind? {
    if video == nil { return .video }
    if audio == nil { return .audio }
    return nil
  }

  private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// Why the draft cannot be sent yet, or nil when it can.
  public var issue: String? {
    if video == nil { return "Pick a video for the picture." }
    if audio == nil { return "Pick a music track for the soundtrack." }
    if trimmedTitle.utf16.count > Self.maximumTitleLength {
      return "Keep the title to at most \(Self.maximumTitleLength) characters."
    }
    return nil
  }

  /// The request, or nil while `issue` is set. Each slot only takes its own kind of file.
  public var request: SceneRequest? {
    guard issue == nil, let video, video.kind == .video, let audio, audio.kind == .audio else { return nil }
    let cover = cover?.kind == .image ? cover : nil
    let title = trimmedTitle.isEmpty ? nil : trimmedTitle
    return SceneRequest(
      videoFileID: video.id, audioFileID: audio.id, fit: fit,
      fadeInSeconds: fades ? nil : 0, fadeOutSeconds: fades ? nil : 0,
      coverFileID: cover?.id, title: title,
      label: title ?? "\(video.displayTitle) + \(audio.displayTitle)")
  }
}

/// The Scene sheet: picks the partner file, the fit and an optional cover, then starts the compose job.
@MainActor
@Observable
public final class SceneComposerViewModel {
  public enum Choices: Equatable, Sendable {
    case loading, loaded([MediaItem]), failed
  }

  public var draft: SceneDraft
  /// The slot the person fills, fixed when the sheet opens so the list stays up after a pick and can be changed.
  public let openSlot: MediaKind?
  /// The other half of the pair, from the person's own gallery.
  public private(set) var partners: Choices = .loading
  /// Images that can be the cover.
  public private(set) var covers: Choices = .loading
  public private(set) var isSubmitting = false
  public var error: StudioSubmitError?

  /// One gallery page per list; Studio shows the newest first, which is where a fresh pair usually is.
  static let pageSize = 60

  @ObservationIgnored private let api: any StudioAPI
  @ObservationIgnored private let media: any MediaAPI
  @ObservationIgnored private let tracker: GenerationTracker

  public init(draft: SceneDraft, api: any StudioAPI, media: any MediaAPI, tracker: GenerationTracker) {
    self.draft = draft
    openSlot = draft.partnerKind
    self.api = api
    self.media = media
    self.tracker = tracker
  }

  public var canSubmit: Bool { !isSubmitting && draft.request != nil }

  public func load() async {
    async let partnerList = list(openSlot)
    async let coverList = list(.image)
    partners = await partnerList
    covers = await coverList
  }

  private func list(_ kind: MediaKind?) async -> Choices {
    guard let kind else { return .loaded([]) }
    do {
      return .loaded(try await media.listMedia(kind: kind, page: 1, limit: Self.pageSize).items)
    } catch {
      return .failed
    }
  }

  /// Fills whichever slot matches the item's kind.
  public func pick(_ item: MediaItem) {
    switch item.kind {
    case .video: draft.video = item
    case .audio: draft.audio = item
    case .image: draft.cover = item
    }
    error = nil
  }

  /// Starts the compose job and hands it to the tracker. Returns whether it started.
  @discardableResult
  public func submit() async -> Bool {
    guard canSubmit, let request = draft.request else { return false }
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      tracker.track(try await api.composeScene(request))
      return true
    } catch {
      self.error = StudioSubmitError(error)
      return false
    }
  }
}
