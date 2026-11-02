import Foundation

/// Everything the app asks of the backend, in app terms. Screens and view models depend on this
/// protocol, never on generated types, so a fake is a dozen lines and a regenerated client cannot
/// ripple into the UI. Later milestones add their operations here.
public protocol B4MAPI: Sendable {
  func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary>
  /// A session's turns, oldest first.
  func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn>
  func creditBalance() async throws -> CreditBalance
}
