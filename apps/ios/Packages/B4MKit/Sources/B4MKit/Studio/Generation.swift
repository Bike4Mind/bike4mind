import Foundation

/// What Studio can make. Video and music run as generation jobs; images (and image edits) run as quests.
public enum GenerationKind: String, CaseIterable, Codable, Sendable {
  case image
  case video
  case music

  public var title: String {
    switch self {
    case .image: "Image"
    case .video: "Video"
    case .music: "Music"
    }
  }
}

/// A generation the server accepted: enough to find it again after a relaunch.
/// `id` is the job id for video and music and the quest id for images.
public struct GenerationHandle: Hashable, Codable, Sendable, Identifiable {
  public let kind: GenerationKind
  public let id: String
  public let prompt: String
  public let startedAt: Date

  public init(kind: GenerationKind, id: String, prompt: String, startedAt: Date) {
    self.kind = kind
    self.id = id
    self.prompt = prompt
    self.startedAt = startedAt
  }

  /// Video and music jobs can be cancelled; an image quest runs to the end.
  public var isCancellable: Bool { kind != .image }
}

/// Where a generation stands. The terminal phases never change again.
public enum GenerationPhase: Equatable, Sendable {
  case queued
  case running(progress: Double?)
  case succeeded
  case failed(GenerationFailure)
  case cancelled

  public var isTerminal: Bool {
    switch self {
    case .queued, .running: false
    case .succeeded, .failed, .cancelled: true
    }
  }
}

/// Why a generation did not produce anything, mapped from the server's error code.
public enum GenerationFailure: Equatable, Sendable {
  case insufficientCredits
  case spendCapExceeded
  /// The content was refused by moderation or the provider's safety filter.
  case blocked
  case modelUnavailable
  case other(code: String?)

  public init(code: String?) {
    switch code {
    case "insufficient_credits": self = .insufficientCredits
    case "spend_cap_exceeded": self = .spendCapExceeded
    case "blocked", "content_blocked": self = .blocked
    case "model_unavailable", "model_disabled": self = .modelUnavailable
    default: self = .other(code: code)
    }
  }

  public var message: String {
    switch self {
    case .insufficientCredits: "You're out of credits. Add credits to keep creating."
    case .spendCapExceeded: "This would go over your spending limit."
    case .blocked: "This request was blocked by the content policy. Try a different prompt."
    case .modelUnavailable: "That model isn't available right now. Pick another one."
    case .other: "Something went wrong while creating this. Try again."
    }
  }
}
