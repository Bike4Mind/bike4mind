import Foundation

/// One message to send with `POST /api/chat`. The server answers immediately with the queued quest; the
/// reply streams over the realtime socket as `streamed_chat_completion` frames.
public struct ChatSendRequest: Hashable, Sendable {
  public enum Target: Hashable, Sendable {
    case session(String)
    /// The server creates a new session and returns its id in the receipt.
    case newConversation
  }

  public let message: String
  public let target: Target
  /// Uploaded files to attach to the turn (`fileIds` on the wire).
  public let fileIDs: [String]

  public init(message: String, target: Target, fileIDs: [String] = []) {
    self.message = message
    self.target = target
    self.fileIDs = fileIDs
  }
}

/// The server's acknowledgement of a queued message.
public struct ChatSendReceipt: Hashable, Sendable {
  public let questID: String
  public let sessionID: String?
  /// Set when the server refused the turn up front (out of credits, spend cap) and recorded it as an
  /// error quest; such a turn will never stream.
  public let kind: QuestTurn.Kind?
  public let errorCode: QuestTurn.ErrorCode?
  public let message: String?

  public init(
    questID: String, sessionID: String?, kind: QuestTurn.Kind? = nil, errorCode: QuestTurn.ErrorCode? = nil,
    message: String? = nil
  ) {
    self.questID = questID
    self.sessionID = sessionID
    self.kind = kind
    self.errorCode = errorCode
    self.message = message
  }

  public var isRefused: Bool { kind == .error }
}

/// The quest snapshot carried by one `streamed_chat_completion` frame
/// (built by b4m-core/services/src/llm/StatusManager.ts).
///
/// `reply` is the CUMULATIVE text so far: it replaces what is shown, never appends. A frame lost to a
/// dropped connection or chunk is therefore healed by the next one. The server keeps the text in
/// `replies` and often sends `reply: null`, so the frame falls back to joining `replies`; the REST quest
/// body derives its `reply` the same way (`questReplyText` in b4m-core/common/src/utils/replyChoices.ts).
public struct ChatQuestFrame: Hashable, Sendable {
  public static let action = "streamed_chat_completion"

  public let questID: String
  public let sessionID: String
  public let prompt: String?
  public let reply: String?
  public let status: QuestTurn.Status?
  public let kind: QuestTurn.Kind?
  /// Only on the final, unoptimized frame; intermediate frames omit it.
  public let errorCode: QuestTurn.ErrorCode?
  public let creditsUsed: Double?
  /// Present on every frame while the quest waits for approval; absent once resolved.
  public let pendingAction: PendingAction?
  public let statusMessage: String?
  /// Length of the raw `replies` text (else the scalar `reply`) before `ReplyVisibility` filtered it; `nil`
  /// when the frame carried no reply text. See `QuestTurn.rawReplyLength`.
  public let rawReplyLength: Int?

  public init(
    questID: String, sessionID: String, prompt: String? = nil, reply: String?, status: QuestTurn.Status?,
    kind: QuestTurn.Kind? = .message, errorCode: QuestTurn.ErrorCode? = nil, creditsUsed: Double? = nil,
    pendingAction: PendingAction? = nil, statusMessage: String? = nil, rawReplyLength: Int? = nil
  ) {
    self.questID = questID
    self.sessionID = sessionID
    self.prompt = prompt
    self.reply = reply
    self.status = status
    self.kind = kind
    self.errorCode = errorCode
    self.creditsUsed = creditsUsed
    self.pendingAction = pendingAction
    self.statusMessage = statusMessage
    self.rawReplyLength = rawReplyLength
  }

  /// `nil` for any other action, or a frame without the quest identity needed to route it.
  public init?(_ frame: ActionFrame) {
    guard frame.action == Self.action, let quest = frame.payload["quest"]?.objectValue,
      let questID = quest["id"]?.stringValue ?? quest["_id"]?.stringValue,
      let sessionID = quest["sessionId"]?.stringValue
    else { return nil }

    self.init(
      questID: questID,
      sessionID: sessionID,
      prompt: quest["prompt"]?.stringValue,
      reply: Self.replyText(reply: quest["reply"], replies: quest["replies"]),
      status: quest["status"]?.stringValue.flatMap(QuestTurn.Status.init(rawValue:)),
      kind: quest["type"]?.stringValue.flatMap(QuestTurn.Kind.init(rawValue:)),
      errorCode: quest["errorCode"]?.stringValue.flatMap(QuestTurn.ErrorCode.init(rawValue:)),
      creditsUsed: quest["creditsUsed"]?.numberValue,
      pendingAction: quest["pendingAction"]?.objectValue.flatMap(PendingAction.init(wire:)),
      statusMessage: frame.payload["statusMessage"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      rawReplyLength: Self.rawReplyLength(reply: quest["reply"], replies: quest["replies"]))
  }
}

extension ChatQuestFrame {
  /// The visible text of the `replies` slots (see `ReplyVisibility`), else a non-empty `reply`. `nil` when
  /// neither has text, so an optimized frame never blanks text an earlier frame showed.
  static func replyText(reply: JSONValue?, replies: JSONValue?) -> String? {
    ReplyVisibility.text(replies: (replies?.arrayValue ?? []).compactMap(\.stringValue), reply: reply?.stringValue)
  }

  /// The unfiltered length behind `replyText`: the joined `replies`, else the scalar `reply`, as the web guard
  /// measures `replies.join('')`. `nil` when neither has text.
  static func rawReplyLength(reply: JSONValue?, replies: JSONValue?) -> Int? {
    let joined = (replies?.arrayValue ?? []).compactMap(\.stringValue).joined()
    if !joined.isEmpty { return joined.count }
    guard let reply = reply?.stringValue, !reply.isEmpty else { return nil }
    return reply.count
  }
}

extension PendingAction {
  /// Wire shape `{tool, params, ts}` with `ts` in epoch milliseconds (IPendingAction on the server).
  init?(wire object: JSONObject) {
    guard let tool = object["tool"]?.stringValue, let timestamp = object["ts"]?.numberValue else { return nil }
    let parameters = (object["params"]?.objectValue ?? [:]).mapValues(Self.display)
    self.init(tool: tool, parameters: parameters, requestedAt: Date(timeIntervalSince1970: timestamp / 1000))
  }

  private static func display(_ value: JSONValue) -> String {
    switch value {
    case .string(let text): text
    case .null: ""
    default: value.encodedString()
    }
  }
}

extension QuestTurn {
  /// This turn with a live frame applied. The frame's reply REPLACES the text (it is cumulative);
  /// fields an optimized frame omits keep their previous value.
  public func applying(_ frame: ChatQuestFrame) -> QuestTurn {
    let next = Self.reply(
      current: StreamedReply(text: reply, rawLength: rawReplyLength),
      incoming: StreamedReply(text: frame.reply, rawLength: frame.rawReplyLength),
      settled: frame.status?.isTerminal ?? false)
    return QuestTurn(
      id: frame.questID,
      prompt: prompt.flatMap { $0.isEmpty ? nil : $0 } ?? frame.prompt,
      reply: next.text,
      status: frame.status ?? status,
      kind: frame.kind ?? kind,
      errorCode: frame.errorCode ?? errorCode,
      createdAt: createdAt,
      creditsUsed: frame.creditsUsed ?? creditsUsed,
      pendingAction: frame.pendingAction,
      rawReplyLength: next.rawLength)
  }

  /// This turn updated from a REST poll (`GET /api/v1/quests/{id}`), which carries neither the prompt
  /// nor `creditsUsed` nor `pendingAction`; those keep their previous value while the quest runs.
  public func applying(polled: QuestTurn) -> QuestTurn {
    let terminal = polled.status?.isTerminal ?? false
    let next = Self.reply(
      current: StreamedReply(text: reply, rawLength: rawReplyLength),
      incoming: StreamedReply(text: polled.reply, rawLength: polled.rawReplyLength),
      settled: terminal)
    return QuestTurn(
      id: id,
      prompt: prompt ?? polled.prompt,
      reply: next.text,
      status: polled.status ?? status,
      kind: polled.kind ?? kind,
      errorCode: polled.errorCode ?? errorCode,
      createdAt: createdAt,
      creditsUsed: polled.creditsUsed ?? creditsUsed,
      pendingAction: terminal ? nil : (polled.pendingAction ?? pendingAction),
      rawReplyLength: next.rawLength)
  }

  public var isFailed: Bool { kind == .error || status == .stopped }

  /// Visible reply text plus the raw length it was filtered from (`nil` when unknown).
  struct StreamedReply: Equatable {
    let text: String?
    let rawLength: Int?
  }

  /// Mid-stream text only grows, as on the web (useStreamingQueryUpdates): a poll reads the quest as last
  /// persisted, up to a heartbeat behind the socket, and a retry resets the server's reply slots. A settled
  /// update is the final display text and wins even when shorter.
  ///
  /// Growth is measured on the RAW slots, as the web guard measures `replies.join('')`: hiding a choices block
  /// or `<think>` reasoning legitimately shrinks the visible text (even to nothing) the moment its marker
  /// completes, and comparing visible lengths would freeze the turn on the partial marker. With no raw length
  /// on one side (a REST poll, a local turn), the visible length is the bound: it never exceeds the raw one.
  static func reply(current: StreamedReply, incoming: StreamedReply, settled: Bool) -> StreamedReply {
    if let incomingRaw = incoming.rawLength {
      if settled { return incoming }
      let currentBound = current.rawLength ?? current.text?.count ?? 0
      return incomingRaw < currentBound ? current : incoming
    }
    guard let incomingText = incoming.text else { return current }
    if settled { return incoming }
    return incomingText.count < (current.text?.count ?? 0) ? current : incoming
  }
}

/// Where a turn's tool approval stands.
///
/// The app shows a pending approval but cannot answer it yet: the web client answers through
/// `POST /api/mcp/confirm`, an internal route that is not part of the public OpenAPI contract the app
/// is generated from. Until it is contracted, approve/deny happens on the web.
public enum ApprovalState: Hashable, Sendable {
  case none
  case awaiting(PendingAction)
  /// Approval requests lapse after `PendingAction.lifetime`; the server refuses a late answer.
  case lapsed(PendingAction)

  public static let canRespondInApp = false

  public init(turn: QuestTurn, at date: Date) {
    self.init(pendingAction: turn.pendingAction, status: turn.status, at: date)
  }

  public init(pendingAction: PendingAction?, status: QuestTurn.Status?, at date: Date) {
    guard let action = pendingAction, status != .done, status != .stopped else {
      self = .none
      return
    }
    self = action.hasLapsed(at: date) ? .lapsed(action) : .awaiting(action)
  }
}
