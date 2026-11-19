import Foundation

/// The brief side of a voice conversation started from a brief: loads it, decides what voice mode reads first,
/// and answers its decisions by voice. Holds its own BriefViewModel, so the brief screen refetches to see
/// anything answered here.
@MainActor
public final class BriefVoiceSession {
  public static let loadFailure = "I couldn't load your brief."

  public static let archiveRefusal = "I can't archive by voice yet. Open the brief to archive it."

  /// Spoken instead of answering while the app is locked or in the background: decisions act on the account,
  /// so a voice in the room is not enough on its own.
  public static let lockedRefusal = "Unlock Bike4Mind to answer decisions by voice."

  /// The words that may cut into a prompt on their own; see `VoiceConversationModel`'s `bargeInWords`.
  public static let bargeInWords: Set<String> = BriefVoiceCommand.oneWordCommands

  public let model: BriefViewModel
  /// Every option the brief's open questions offer, as read aloud; set by `prepare()`.
  public private(set) var answerPhrases: Set<String> = []
  /// What a spoken "yes" is waiting to send. Any other utterance disarms it.
  private var awaitingConfirm: PendingAnswer?
  private let canAnswer: @MainActor () -> Bool

  private enum PendingAnswer {
    case approve(decisionID: String)
    case reply(decisionID: String, text: String, choiceIndex: Int?)

    var confirmation: BriefVoiceConfirmation {
      if case .approve = self { return .approval }
      return .answer
    }
  }

  /// A composing brief is polled once, briefly: voice mode should speak promptly, not wait out a compose.
  /// `canAnswer` is checked before every answer (the app is unlocked and in the foreground).
  public init(
    briefID: String, api: any BriefAPI, pendingActions: (any PendingActionAPI)?,
    canAnswer: @escaping @MainActor () -> Bool = { true }
  ) {
    model = BriefViewModel(
      api: api, briefID: briefID, pendingActions: pendingActions, pollInterval: .seconds(1),
      pollWindow: .seconds(1))
    self.canAnswer = canAnswer
  }

  /// What voice mode says on opening, and the brief text that seeds the first chat turn (nil when the brief
  /// could not be loaded, so plain voice continues without it).
  public func prepare() async -> (opening: [String], context: String?) {
    await model.load()
    guard case .loaded = model.state, let brief = model.brief else { return ([Self.loadFailure], nil) }
    let sections = SpokenBriefRenderer.sections(for: brief)
    answerPhrases = Set(
      brief.decisions.filter { $0.question?.state == .open }
        .flatMap { $0.question?.options ?? [] }
        .map(SpokenBriefRenderer.plain)
        .filter { !$0.isEmpty })
    return (sections, sections.joined(separator: "\n"))
  }

  /// Answers the first decision still waiting on the user, or returns nil so the utterance goes to the chat:
  /// with nothing pending, or when the words are not a triage command. "Archive" is always refused here, since
  /// briefs have no archive action yet and the chat could not do it either. Approvals, replies and choices are
  /// read back and sent only on a "yes"; a deny acts at once.
  public func handle(_ utterance: String) async -> String? {
    let armed = awaitingConfirm
    awaitingConfirm = nil
    let decision = current
    let command = BriefVoiceCommand.parse(
      utterance, options: decision?.question?.options ?? [], confirming: armed.map(\.confirmation))
    if command == .archive { return Self.archiveRefusal }
    if command == nil, let armed, BriefVoiceCommand.isMixed(utterance, confirming: armed.confirmation) {
      return keep(armed)
    }
    guard let decision, let command else { return nil }
    if command != .cancel, !canAnswer() { return Self.lockedRefusal }
    switch command {
    case .archive:
      return Self.archiveRefusal
    case .cancel:
      guard let armed else { return nil }
      if case .approve = armed { return join("Okay, not approved.", prompt(for: decision)) }
      return join("Okay, not sent.", prompt(for: decision))
    case .confirm:
      guard let armed else { return nil }
      return await send(armed)
    case .approve:
      if decision.approval == nil, let armed { return keep(armed) }
      guard decision.approval != nil else { return "That one is a question. Say reply and your answer." }
      if let local = model.approvalStates[decision.id], !local.offersDecision {
        return "That one can't be approved. Say deny to turn it down, or open the brief."
      }
      awaitingConfirm = .approve(decisionID: decision.id)
      let text = spoken(decision.text)
      return text.isEmpty ? "Approve it? Say yes to go ahead." : "Approve \(text)? Say yes to go ahead."
    case .deny:
      if decision.approval == nil, let armed { return keep(armed) }
      guard decision.approval != nil else { return "That one is a question. Say reply and your answer." }
      await model.decide(decision, .deny)
      return approvalOutcome(decision)
    case .reply(let text):
      guard decision.question != nil else { return "Say approve or deny." }
      awaitingConfirm = .reply(decisionID: decision.id, text: text, choiceIndex: nil)
      return "Reply \(spoken(text))? Say yes to send it."
    case .choose(let index):
      guard let options = decision.question?.options, options.indices.contains(index) else { return nil }
      awaitingConfirm = .reply(decisionID: decision.id, text: options[index], choiceIndex: index)
      return "Choose \(spoken(options[index]))? Say yes to send it."
    }
  }

  /// Leaves the armed answer waiting and asks for a plain yes or no, for words that neither confirm nor
  /// clearly move on.
  private func keep(_ armed: PendingAnswer) -> String {
    awaitingConfirm = armed
    if case .approve = armed { return "Say yes to approve it or no to cancel." }
    return "Say yes to send it or no to cancel."
  }

  private func send(_ armed: PendingAnswer) async -> String {
    switch armed {
    case .approve(let id):
      guard let target = openDecision(id) else { return join("That one was already answered.", next()) }
      await model.decide(target, .approve)
      return approvalOutcome(target)
    case .reply(let id, let text, let choiceIndex):
      guard let target = openDecision(id) else { return join("That one was already answered.", next()) }
      await model.reply(target, text: text, choiceIndex: choiceIndex)
      return replyOutcome(target)
    }
  }

  private func openDecision(_ id: String) -> BriefDecision? {
    model.brief?.decisions.first { $0.id == id && isOpen($0) }
  }

  private func spoken(_ text: String) -> String {
    SpokenBriefRenderer.plain(text).trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
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

/// What is waiting for a spoken yes: an approval, or a reply or choice to a question.
public enum BriefVoiceConfirmation: Hashable, Sendable {
  case approval, answer
}

/// A spoken triage command. Deliberately narrow: anything that is not plainly a command (a negation, a
/// longer sentence) parses to nil and goes to the chat instead.
public enum BriefVoiceCommand: Hashable, Sendable {
  case approve, deny, confirm, cancel, archive
  case reply(String)
  case choose(Int)

  /// Commands short enough to be said over a prompt; `parse` maps each of these alone to a command.
  static let oneWordCommands: Set<String> = Set(commandWords.keys).subtracting(["archive"])

  /// The most words a bare command may run to ("approve that one"); longer is treated as conversation.
  static let maxCommandWords = 3

  static let commandWords: [String: BriefVoiceCommand] = [
    "approve": .approve, "approved": .approve,
    "deny": .deny, "denied": .deny, "reject": .deny, "decline": .deny,
    "yes": .confirm, "yeah": .confirm, "yep": .confirm, "confirm": .confirm,
    "no": .cancel, "nope": .cancel, "cancel": .cancel,
    "archive": .archive,
  ]

  /// `confirming` is set while an answer waits for a yes: yes and no then win over option labels that match them.
  public static func parse(
    _ utterance: String, options: [String] = [], confirming: BriefVoiceConfirmation? = nil
  ) -> BriefVoiceCommand? {
    let words = normalized(utterance)
    guard let verb = words.first else { return nil }
    let short = words.count <= maxCommandWords
    let mixed = mixes(words, confirming: confirming)
    let spoken = words.joined(separator: " ")
    let option = options.firstIndex { normalized($0).joined(separator: " ") == spoken }
    // A whole multi-word label ("No, wait") is that option even while an answer waits; only a lone yes or no
    // is taken as the confirmation.
    if let option, words.count > 1 { return .choose(option) }
    if confirming != nil, short, !mixed, let verbCommand = command(verb, confirming: confirming),
      verbCommand == .confirm || verbCommand == .cancel
    {
      return verbCommand
    }
    if let option { return .choose(option) }
    if verb == "reply" || verb == "answer" {
      let raw = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
      let text = raw.drop { !$0.isWhitespace }.trimmingCharacters(in: .whitespacesAndNewlines)
      return text.isEmpty ? nil : .reply(text)
    }
    guard short, !mixed else { return nil }
    return commandWords[verb]
  }

  /// True for a short utterance that `parse` drops because it holds words of two different commands.
  static func isMixed(_ utterance: String, confirming: BriefVoiceConfirmation?) -> Bool {
    let words = normalized(utterance)
    return words.count <= maxCommandWords && mixes(words, confirming: confirming)
  }

  // Words of two different commands ("deny it approve", "yes no") are most likely the tail of the app's own
  // prompt heard ahead of the answer, so neither is acted on.
  private static func mixes(_ words: [String], confirming: BriefVoiceConfirmation?) -> Bool {
    Set(words.compactMap { command($0, confirming: confirming) }).count > 1
  }

  // While an approval waits for a yes, approve agrees and deny refuses, so "yes approve" is one command. Not
  // for a reply or choice: there "approve" may be an option label and must not send the other answer.
  private static func command(_ word: String, confirming: BriefVoiceConfirmation?) -> BriefVoiceCommand? {
    guard confirming == .approval, let command = commandWords[word] else { return commandWords[word] }
    switch command {
    case .approve: return .confirm
    case .deny: return .cancel
    default: return command
    }
  }

  private static func normalized(_ text: String) -> [String] { SpokenWords.normalized(text) }
}
