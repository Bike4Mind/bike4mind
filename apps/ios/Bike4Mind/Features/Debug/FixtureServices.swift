#if DEBUG
  import B4MKit
  import Foundation

  /// Launch with the environment variable `B4M_UI_FIXTURES=1` to run the signed-in UI against canned data:
  /// no sign-in, no network. For screenshots and UI work while a stage with the endpoints is unavailable.
  enum FixtureServices {
    static var isEnabled: Bool { ProcessInfo.processInfo.environment["B4M_UI_FIXTURES"] == "1" }

    static let api: any B4MAPI = FixtureAPI()
    static let pushTokenAPI: any PushTokenAPI = NoopPushTokenAPI()

    private struct NoopPushTokenAPI: PushTokenAPI {
      func registerPushToken(_ token: String, environment: PushEnvironment, appVersion: String?) async throws {}
      func unregisterPushToken(_ token: String) async throws {}
    }

    private struct FixtureAPI: B4MAPI {
      private static let now = Date()

      func listSessions(cursor: String?, limit: Int) async throws -> Page<SessionSummary> {
        let names = ["Trip planning", "Quarterly metrics review", "Untitled", "Recipe ideas", "Contract summary"]
        let sessions = names.enumerated().map { index, name in
          SessionSummary(
            id: "fixture-\(index)", name: name, lastUsedModel: index.isMultiple(of: 2) ? "claude-sonnet-4" : nil,
            firstCreated: Self.now.addingTimeInterval(-Double(index + 1) * 86_400),
            lastUpdated: Self.now.addingTimeInterval(-Double(index) * 5_400))
        }
        return Page(items: sessions, nextCursor: nil)
      }

      func listSessionQuests(sessionID: String, cursor: String?, limit: Int) async throws -> Page<QuestTurn> {
        let turns = [
          QuestTurn(
            id: "q1", prompt: "Plan a three day trip to Lisbon.",
            reply:
              "Here is a **three day plan**:\n\n1. Day one: Alfama and the castle\n2. Day two: Belem\n3. Day three: Sintra\n\nUse `Tram 28` early to avoid queues.",
            status: .done, kind: .message, createdAt: Self.now.addingTimeInterval(-3_600), creditsUsed: 42),
          QuestTurn(
            id: "q2", prompt: "Book the restaurants.", reply: "", status: .pending, kind: .message,
            createdAt: Self.now.addingTimeInterval(-600),
            pendingAction: PendingAction(
              tool: "web_browse", parameters: ["url": "https://example.com/reserve", "party": "2"],
              requestedAt: Self.now.addingTimeInterval(-600))),
          QuestTurn(
            id: "q3", prompt: "Write the full itinerary as a book.", reply: "Not enough credits.", status: .stopped,
            kind: .error, errorCode: .insufficientCredits, createdAt: Self.now.addingTimeInterval(-120)),
          QuestTurn(
            id: "q4", prompt: "Summarize.", reply: nil, status: .running, kind: .message,
            createdAt: Self.now.addingTimeInterval(-20)),
        ]
        return Page(items: turns, nextCursor: nil)
      }

      func creditBalance() async throws -> CreditBalance { CreditBalance(credits: 31_667) }
    }
  }
#endif
