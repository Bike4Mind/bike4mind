#if DEBUG
  import B4MKit
  import Foundation

  /// Launch with the environment variable `B4M_UI_FIXTURES=1` to run the signed-in UI against canned data:
  /// no sign-in, no network. For screenshots and UI work while a stage with the endpoints is unavailable.
  enum FixtureServices {
    static var isEnabled: Bool { ProcessInfo.processInfo.environment["B4M_UI_FIXTURES"] == "1" }

    static let api: any B4MAPI = FixtureAPI()
    static let realtime = FixtureRealtime()
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

      func sendChatMessage(_ request: ChatSendRequest) async throws -> ChatSendReceipt {
        let questID = "fixture-quest-\(UUID().uuidString.prefix(8))"
        let sessionID: String
        switch request.target {
        case .session(let id): sessionID = id
        case .newConversation: sessionID = "fixture-new"
        }
        await FixtureServices.realtime.streamReply(questID: questID, sessionID: sessionID, prompt: request.message)
        return ChatSendReceipt(questID: questID, sessionID: sessionID)
      }

      func quest(id: String) async throws -> QuestTurn {
        throw APIError.notFound
      }
    }

    /// Streams a canned reply as cumulative `streamed_chat_completion` frames, so the chat screen can be
    /// exercised without a server.
    actor FixtureRealtime: RealtimeClient {
      private var listeners: [UUID: AsyncStream<RealtimeEvent>.Continuation] = [:]

      var connectionState: RealtimeConnectionState { .connected }

      func start() {}
      func stop() {}
      func resume() {}
      func reauthenticate(accessToken: String) {}
      func subscribe(_ request: SubscriptionRequest) -> AsyncStream<DataUpdate> { AsyncStream { _ in } }

      func events() -> AsyncStream<RealtimeEvent> {
        let (stream, continuation) = AsyncStream<RealtimeEvent>.makeStream()
        listeners[UUID()] = continuation
        return stream
      }

      func streamReply(questID: String, sessionID: String, prompt: String) {
        let reply =
          "Here is a quick answer to **\(prompt)**.\n\n1. First, a short point.\n2. Then another.\n\nThat streamed in by replacement."
        let words = reply.split(separator: " ", omittingEmptySubsequences: false)
        Task {
          try? await Task.sleep(for: .milliseconds(400))
          for count in stride(from: 1, through: words.count, by: 2) {
            emit(questID, sessionID, prompt, words.prefix(count).joined(separator: " "), "running")
            try? await Task.sleep(for: .milliseconds(60))
          }
          emit(questID, sessionID, prompt, reply, "done")
        }
      }

      private func emit(_ questID: String, _ sessionID: String, _ prompt: String, _ reply: String, _ status: String) {
        let quest: JSONObject = [
          "id": .string(questID), "sessionId": .string(sessionID), "prompt": .string(prompt),
          "reply": .string(reply), "status": .string(status), "type": "message", "creditsUsed": 12,
        ]
        let frame = ActionFrame(
          action: ChatQuestFrame.action,
          payload: ["action": .string(ChatQuestFrame.action), "quest": .object(quest), "statusMessage": ""])
        for listener in listeners.values { listener.yield(.frame(frame)) }
      }
    }
  }
#endif
