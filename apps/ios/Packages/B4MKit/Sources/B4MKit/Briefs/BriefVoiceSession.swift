import Foundation

/// The brief side of a voice conversation started from a brief: loads it, decides what voice mode reads first,
/// and answers its decisions by voice. Holds its own BriefViewModel, so the brief screen refetches to see
/// anything answered here.
@MainActor
public final class BriefVoiceSession {
  public static let loadFailure = "I couldn't load your brief."

  public static let archiveRefusal = "I can't archive by voice yet. Open the brief to archive it."

  public let model: BriefViewModel
  /// The approval a spoken "approve" is waiting on a "yes" for. Any other utterance disarms it.
  private var awaitingConfirm: String?

  /// A composing brief is polled once, briefly: voice mode should speak promptly, not wait out a compose.
  public init(briefID: String, api: any BriefAPI, pendingActions: (any PendingActionAPI)?) {
    model = BriefViewModel(
      api: api, briefID: briefID, pendingActions: pendingActions, pollInterval: .seconds(1),
      pollWindow: .seconds(1))
  }

  /// What voice mode says on opening, and the brief text that seeds the first chat turn (nil when the brief
  /// could not be loaded, so plain voice continues without it).
  public func prepare() async -> (opening: [String], context: String?) {
    await model.load()
    guard case .loaded = model.state, let brief = model.brief else { return ([Self.loadFailure], nil) }
    let sections = SpokenBriefRenderer.sections(for: brief)
    return (sections, sections.joined(separator: "\n"))
  }

  /// Answers the first decision still waiting on the user, or returns nil so the utterance goes to the chat:
  /// with nothing pending, or when the words are not a triage command. "Archive" is always refused here, since
  /// briefs have no archive action yet and the chat could not do it either.
  public func handle(_ utterance: String) async -> String? {
    let armed = awaitingConfirm
    awaitingConfirm = nil
    let decision = current
    let command = BriefVoiceCommand.parse(utterance, options: decision?.question?.options ?? [])
    if command == .archive { return Self.archiveRefusal }
    guard let decision, let command else { return nil }
    switch command {
    case .archive:
      return Self.archiveRefusal
    case .confirm, .cancel:
      guard let armed else { return nil }
      guard command == .confirm else { return join("Okay, not approved.", prompt(for: decision)) }
      guard let target = model.brief?.decisions.first(where: { $0.id == armed }), isOpen(target) else {
        return join("That one was already answered.", next())
      }
      await model.decide(target, .approve)
      return approvalOutcome(target)
    case .approve:
      guard decision.approval != nil else { return "That one is a question. Say reply and your answer." }
      awaitingConfirm = decision.id
      let text = SpokenBriefRenderer.plain(decision.text).trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
      return text.isEmpty ? "Approve it? Say yes to confirm." : "Approve \(text)? Say yes to confirm."
    case .deny:
      guard decision.approval != nil else { return "That one is a question. Say reply and your answer." }
      await model.decide(decision, .deny)
      return approvalOutcome(decision)
    case .reply(let text):
      guard decision.question != nil else { return "Say approve or deny." }
      await model.reply(decision, text: text)
      return replyOutcome(decision)
    case .choose(let index):
      guard let options = decision.question?.options, options.indices.contains(index) else { return nil }
      await model.reply(decision, text: options[index], choiceIndex: index)
      return replyOutcome(decision)
    }
  }

  /// The first decision the user can still answer. One answered (or refused for good) here stays pending
  /// server-side until its quest settles, so the local outcome is what moves the cursor past it.
  private var current: BriefDecision? {
    model.brief?.decisions.first(where: isOpen)
  }

  private func isOpen(_ decision: BriefDecision) -> Bool {
    guard SpokenBriefRenderer.isPending(decision) else { return false }
    if let local = model.approvalStates[decision.id], !local.offersDeny { return false }
    return model.replyStates[decision.id] != .sent
  }

  private func approvalOutcome(_ decision: BriefDecision) -> String {
    switch model.approvalStates[decision.id] {
    case .answered(let result): join(result.decision == .approve ? "Approved." : "Denied.", next())
    case .failed(let failure): failure.message
    case .open, .submitting, nil: join("That one was already answered.", next())
    }
  }

  private func replyOutcome(_ decision: BriefDecision) -> String {
    switch model.replyStates[decision.id] {
    case .sent: join("Reply sent.", next())
    case .failed(let failure): failure.message
    case .submitting, nil: join("That one was already answered.", next())
    }
  }

  private func next() -> String {
    guard let decision = current, let prompt = SpokenBriefRenderer.prompt(for: decision) else {
      return "That's everything."
    }
    return "Next: \(prompt)"
  }

  private func prompt(for decision: BriefDecision) -> String {
    SpokenBriefRenderer.prompt(for: decision) ?? ""
  }

  private func join(_ first: String, _ second: String) -> String {
    second.isEmpty ? first : "\(first) \(second)"
  }
}

/// A spoken triage command. Deliberately narrow: anything that is not plainly a command (a negation, a
/// longer sentence) parses to nil and goes to the chat instead.
public enum BriefVoiceCommand: Equatable, Sendable {
  case approve, deny, confirm, cancel, archive
  case reply(String)
  case choose(Int)

  /// The most words a bare command may run to ("approve that one"); longer is treated as conversation.
  static let maxCommandWords = 3

  public static func parse(_ utterance: String, options: [String] = []) -> BriefVoiceCommand? {
    let words = normalized(utterance)
    guard let verb = words.first else { return nil }
    let spoken = words.joined(separator: " ")
    if let index = options.firstIndex(where: { normalized($0).joined(separator: " ") == spoken }) {
      return .choose(index)
    }
    if verb == "reply" || verb == "answer" {
      let raw = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
      let text = raw.drop { !$0.isWhitespace }.trimmingCharacters(in: .whitespacesAndNewlines)
      return text.isEmpty ? nil : .reply(text)
    }
    guard words.count <= maxCommandWords else { return nil }
    switch verb {
    case "approve", "approved": return .approve
    case "deny", "denied", "reject", "decline": return .deny
    case "yes", "yeah", "yep", "confirm": return .confirm
    case "no", "nope", "cancel": return .cancel
    case "archive": return .archive
    default: return nil
    }
  }

  private static func normalized(_ text: String) -> [String] {
    let kept = text.lowercased().unicodeScalars
      .filter { $0 != "'" && $0 != "\u{2019}" }
      .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
    return String(kept).split(separator: " ").map(String.init)
  }
}
