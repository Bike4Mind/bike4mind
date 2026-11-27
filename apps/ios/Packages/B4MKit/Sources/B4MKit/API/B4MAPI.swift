import Foundation

/// Everything the app asks of the backend, in app terms. Screens and view models depend on this
/// protocol, never on generated types, so a fake is a dozen lines and a regenerated client cannot
/// ripple into the UI. Later milestones add their operations here.
public protocol B4MAPI: Sendable {
  func session(id: String) async throws -> SessionSummary
  /// Renames a session; `name` is already trimmed and non-empty. Returns the server's copy.
  func renameSession(id: String, name: String) async throws -> SessionSummary
  /// Deletes a session. A session that is already gone (404) counts as deleted and does not throw.
  func deleteSession(id: String) async throws
  func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary>
  /// A session's turns, oldest first.
  func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn>
  func creditBalance() async throws -> CreditBalance
  /// Queues a chat message; the reply streams over the realtime socket (see `ChatQuestFrame`).
  func sendChatMessage(_ request: ChatSendRequest) async throws -> ChatSendReceipt
  /// One quest's current state; the fallback when the realtime socket is down.
  func quest(id: String) async throws -> QuestTurn
}
