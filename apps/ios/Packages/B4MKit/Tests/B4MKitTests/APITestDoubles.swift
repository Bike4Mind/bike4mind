import Foundation

@testable import B4MKit

/// Scripted token provider that records how the API layer treats it.
actor FakeTokens: AccessTokenProviding {
  private var queue: [Result<String, any Error>]
  private(set) var invalidations = 0
  private(set) var rejections = 0
  private(set) var accessTokenCalls = 0

  init(_ tokens: [Result<String, any Error>] = [.success("token-1"), .success("token-2")]) {
    queue = tokens
  }

  func accessToken() throws -> String {
    accessTokenCalls += 1
    guard !queue.isEmpty else { return "token-exhausted" }
    return try queue.removeFirst().get()
  }

  func invalidateAccessToken(_ token: String) { invalidations += 1 }
  func sessionRejected() { rejections += 1 }
}

/// In-memory `B4MAPI` that serves scripted pages and records the cursors it was asked for.
actor FakeAPI: B4MAPI {
  var sessionPages: [String?: Page<SessionSummary>] = [:]
  var questPages: [String?: Page<QuestTurn>] = [:]
  var balance = CreditBalance(credits: 0)
  var failure: APIError?
  private(set) var sessionCursors: [String?] = []
  private(set) var questCursors: [String?] = []

  func setSessionPages(_ pages: [String?: Page<SessionSummary>]) { sessionPages = pages }
  func setQuestPages(_ pages: [String?: Page<QuestTurn>]) { questPages = pages }
  func setFailure(_ failure: APIError?) { self.failure = failure }
  func setBalance(_ balance: CreditBalance) { self.balance = balance }

  func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary> {
    sessionCursors.append(cursor)
    if let failure { throw failure }
    return sessionPages[cursor] ?? Page(items: [], nextCursor: nil)
  }

  func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn> {
    questCursors.append(cursor)
    if let failure { throw failure }
    return questPages[cursor] ?? Page(items: [], nextCursor: nil)
  }

  func creditBalance() async throws -> CreditBalance {
    if let failure { throw failure }
    return balance
  }

  private(set) var sentMessages: [ChatSendRequest] = []
  var sendResult: Result<ChatSendReceipt, APIError> = .success(ChatSendReceipt(questID: "quest-1", sessionID: "s1"))
  /// Served in order by `quest(id:)`; the last entry repeats.
  var polledQuests: [QuestTurn] = []
  private(set) var questLookups: [String] = []

  func setSendResult(_ result: Result<ChatSendReceipt, APIError>) { sendResult = result }
  func setPolledQuests(_ quests: [QuestTurn]) { polledQuests = quests }

  private var holdingSends = false
  private var heldSends: [CheckedContinuation<Void, Never>] = []

  /// Parks every send until `releaseSends()`, to let a test land a frame before the POST answers.
  func holdSends() { holdingSends = true }

  func releaseSends() {
    holdingSends = false
    for send in heldSends { send.resume() }
    heldSends.removeAll()
  }

  func sendChatMessage(_ request: ChatSendRequest) async throws -> ChatSendReceipt {
    sentMessages.append(request)
    if holdingSends { await withCheckedContinuation { heldSends.append($0) } }
    // A real request fails when its task is cancelled; the fake does too, so a cancelled send is visible.
    if Task.isCancelled { throw APIError.offline }
    return try sendResult.get()
  }

  func quest(id: String) async throws -> QuestTurn {
    questLookups.append(id)
    guard !polledQuests.isEmpty else { throw APIError.notFound }
    return polledQuests.count > 1 ? polledQuests.removeFirst() : polledQuests[0]
  }
}

enum Samples {
  static let date = Date(timeIntervalSince1970: 1_800_000_000)

  static func session(_ id: String, updated: TimeInterval = 0) -> SessionSummary {
    SessionSummary(
      id: id, name: "Session \(id)", lastUsedModel: nil, firstCreated: date,
      lastUpdated: date.addingTimeInterval(updated))
  }

  static func quest(
    _ id: String, prompt: String? = "p", reply: String? = "r", status: QuestTurn.Status? = .done,
    pendingAction: PendingAction? = nil
  ) -> QuestTurn {
    QuestTurn(
      id: id, prompt: prompt, reply: reply, status: status, createdAt: date, pendingAction: pendingAction)
  }
}
