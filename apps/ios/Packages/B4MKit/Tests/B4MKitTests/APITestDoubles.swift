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
  private(set) var sessionLookups: [String] = []
  var sessionsByID: [String: SessionSummary] = [:]

  func setSessions(_ sessions: [SessionSummary]) {
    sessionsByID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
  }

  func session(id: String) async throws -> SessionSummary {
    sessionLookups.append(id)
    if let failure { throw failure }
    guard let session = sessionsByID[id] else { throw APIError.notFound }
    return session
  }

  private(set) var renames: [(id: String, name: String)] = []
  private(set) var deletes: [String] = []
  var renameFailure: APIError?
  var deleteFailure: APIError?

  func setRenameFailure(_ failure: APIError?) { renameFailure = failure }
  func setDeleteFailure(_ failure: APIError?) { deleteFailure = failure }

  private var holdingMutations = false
  private var heldMutations: [CheckedContinuation<Void, Never>] = []

  /// Parks every rename and delete until `releaseMutations()`, so a test can act while one is in flight.
  func holdMutations() { holdingMutations = true }

  func releaseMutations() {
    holdingMutations = false
    for mutation in heldMutations { mutation.resume() }
    heldMutations.removeAll()
  }

  func renameSession(id: String, name: String) async throws -> SessionSummary {
    renames.append((id, name))
    if holdingMutations { await withCheckedContinuation { heldMutations.append($0) } }
    if let renameFailure { throw renameFailure }
    let existing =
      sessionsByID[id]
      ?? SessionSummary(
        id: id, name: name, lastUsedModel: nil, firstCreated: .distantPast, lastUpdated: .distantPast)
    let renamed = SessionSummary(
      id: id, name: name, lastUsedModel: existing.lastUsedModel, firstCreated: existing.firstCreated,
      lastUpdated: existing.lastUpdated)
    sessionsByID[id] = renamed
    return renamed
  }

  func deleteSession(id: String) async throws {
    deletes.append(id)
    if holdingMutations { await withCheckedContinuation { heldMutations.append($0) } }
    // Mirrors `APIClient.deleteSession`, which treats a 404 as already deleted.
    if let deleteFailure, deleteFailure != .notFound { throw deleteFailure }
    sessionsByID[id] = nil
  }

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

  private var holdingSessionLists = false
  private var heldSessionLists: [CheckedContinuation<Void, Never>] = []

  /// Parks every `listSessions` after it records its cursor until `releaseSessionLists()`; the scripted page
  /// or failure is read on release.
  func holdSessionLists() { holdingSessionLists = true }

  func releaseSessionLists() {
    holdingSessionLists = false
    for request in heldSessionLists { request.resume() }
    heldSessionLists.removeAll()
  }

  func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary> {
    sessionCursors.append(cursor)
    if holdingSessionLists { await withCheckedContinuation { heldSessionLists.append($0) } }
    try Task.checkCancellation()
    if let failure { throw failure }
    return sessionPages[cursor] ?? Page(items: [], nextCursor: nil)
  }

  func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn> {
    questCursors.append(cursor)
    if let failure { throw failure }
    let page = questPages[cursor] ?? Page(items: [], nextCursor: nil)
    if holdingNextQuestHistory {
      holdingNextQuestHistory = false
      await withCheckedContinuation { heldQuestHistory.append($0) }
    }
    return page
  }

  private var holdingNextQuestHistory = false
  private var heldQuestHistory: [CheckedContinuation<Void, Never>] = []

  /// Captures the next response before suspending, like an older history request already in flight.
  func holdNextQuestHistory() { holdingNextQuestHistory = true }

  func releaseQuestHistory() {
    for request in heldQuestHistory { request.resume() }
    heldQuestHistory.removeAll()
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
