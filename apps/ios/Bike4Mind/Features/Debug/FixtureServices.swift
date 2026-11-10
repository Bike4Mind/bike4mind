#if DEBUG
  import B4MKit
  import Foundation

  /// Launch with the environment variable `B4M_UI_FIXTURES=1` to run the signed-in UI against canned data:
  /// no sign-in, no network. For screenshots and UI work while a stage with the endpoints is unavailable.
  enum FixtureServices {
    static var isEnabled: Bool { ProcessInfo.processInfo.environment["B4M_UI_FIXTURES"] == "1" }

    static let api: any B4MAPI = FixtureAPI()
    static let media: any MediaAPI = FixtureMediaAPI()
    static let realtime = FixtureRealtime()
    static let pushTokenAPI: any PushTokenAPI = NoopPushTokenAPI()
    static let agentRunAPI: any AgentRunAPI = FixtureAgentRunAPI()
    static let account: any AccountAPI = FixtureAccountAPI()
    static let stepUp: any StepUpAPI = FixtureStepUpAPI()
    /// The first fixture session's turn that starts out working and settles a few seconds after it is opened.
    static let workingQuestID = "fixture-0-q4"

    /// `B4M_UI_FIXTURE_ACCOUNT` picks the account-deletion story: `org-transfer` (the 409 list),
    /// `pending` (launch on the restore screen) or the default (deletion succeeds and signs out).
    enum AccountScenario: String {
      case success, orgTransfer = "org-transfer", pending
    }

    static var accountScenario: AccountScenario {
      AccountScenario(rawValue: ProcessInfo.processInfo.environment["B4M_UI_FIXTURE_ACCOUNT"] ?? "") ?? .success
    }

    private struct FixtureAccountAPI: AccountAPI {
      func requestDeletion() async throws -> AccountDeletionReceipt {
        if FixtureServices.accountScenario == .orgTransfer {
          throw AccountDeletionFailure.organizationTransferRequired([
            AccountOrganization(id: "fixture-org-1", name: "Acme Analytics"),
            AccountOrganization(id: "fixture-org-2", name: "Weekend Projects"),
          ])
        }
        return AccountDeletionReceipt(scheduledFor: Date().addingTimeInterval(30 * 86_400))
      }

      func restoreDeletion() async throws {}
    }

    private struct FixtureStepUpAPI: StepUpAPI {
      func fetchOptions() async throws -> StepUpOptions {
        StepUpOptions(methods: [.password, .email], stepUpUntil: nil)
      }
      func sendEmailCode() async throws -> String { "fixture-pending-token" }
      func verify(_ proof: StepUpProof) async throws -> Date { Date().addingTimeInterval(300) }
    }

    private struct NoopPushTokenAPI: PushTokenAPI {
      func registerPushToken(_ token: String, environment: PushEnvironment, appVersion: String?) async throws {}
      func unregisterPushToken(_ token: String) async throws {}
      func registerLiveActivityToken(
        _ token: String, activityID: String, questID: String, environment: PushEnvironment, appVersion: String?
      ) async throws {}
    }

    /// A scripted agent run: each poll advances it one stage, through an approval, to completion, so the
    /// Live Activity can be watched going through every state without a server.
    private actor FixtureAgentRunAPI: AgentRunAPI {
      private var polls: [String: Int] = [:]
      private var sequence = 0

      func startRun(sessionID: String, message: String) async throws -> AgentRunReceipt {
        sequence += 1
        return AgentRunReceipt(
          executionID: "fixture-exec-\(sequence)", questID: "fixture-run-quest-\(sequence)", sessionID: sessionID)
      }

      func run(id: String) async throws -> AgentRunStatus {
        let count = (polls[id] ?? 0) + 1
        polls[id] = count
        let search = AgentRunStatus.Step(type: .action, toolName: "web_search")
        let seen = AgentRunStatus.Step(type: .observation)
        let write = AgentRunStatus.Step(type: .action, toolName: "write_report")
        switch count {
        case 1: return AgentRunStatus(id: id, state: .running, steps: [search])
        case 2: return AgentRunStatus(id: id, state: .running, steps: [search, seen])
        case 3, 4: return AgentRunStatus(id: id, state: .awaitingPermission, steps: [search, seen])
        case 5: return AgentRunStatus(id: id, state: .running, steps: [search, seen, write])
        default: return AgentRunStatus(id: id, state: .completed, steps: [search, seen, write])
        }
      }
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
        let now = Self.now
        func done(_ id: String, _ prompt: String, _ reply: String, ago: TimeInterval, credits: Double = 12) -> QuestTurn
        {
          QuestTurn(
            id: id, prompt: prompt, reply: reply, status: .done, kind: .message,
            createdAt: now.addingTimeInterval(-ago), creditsUsed: credits)
        }
        let turns: [QuestTurn]
        switch sessionID {
        case "fixture-0":
          let resolved = await FixtureServices.realtime.scheduleWorkingTurn(
            questID: FixtureServices.workingQuestID, sessionID: sessionID, prompt: "Summarize.",
            reply: "Lisbon in three days: **Alfama** on day one, **Belem** on day two, **Sintra** on day three.")
          turns = [
            done(
              "fixture-0-q1", "Plan a three day trip to Lisbon.",
              "Here is a **three day plan**:\n\n1. Day one: Alfama and the castle\n2. Day two: Belem\n3. Day three: Sintra\n\nUse `Tram 28` early to avoid queues.",
              ago: 3_600, credits: 42),
            QuestTurn(
              id: "fixture-0-q2", prompt: "Book the restaurants.", reply: "", status: .pending, kind: .message,
              createdAt: now.addingTimeInterval(-600),
              pendingAction: PendingAction(
                tool: "web_browse", parameters: ["url": "https://example.com/reserve", "party": "2"],
                requestedAt: now.addingTimeInterval(-600))),
            QuestTurn(
              id: "fixture-0-q3", prompt: "Write the full itinerary as a book.", reply: "Not enough credits.",
              status: .stopped, kind: .error, errorCode: .insufficientCredits,
              createdAt: now.addingTimeInterval(-120)),
            resolved
              ? done(
                FixtureServices.workingQuestID, "Summarize.",
                "Lisbon in three days: **Alfama** on day one, **Belem** on day two, **Sintra** on day three.", ago: 20)
              : QuestTurn(
                id: FixtureServices.workingQuestID, prompt: "Summarize.", reply: nil, status: .running, kind: .message,
                createdAt: now.addingTimeInterval(-20)),
          ]
        case "fixture-1":
          turns = [
            done(
              "fixture-1-q1", "What moved revenue in Q3?",
              "Three drivers:\n\n- **Enterprise renewals** up 14%\n- A pricing change in August\n- Churn down to 2.1%",
              ago: 7_200,
              credits: 31),
            done(
              "fixture-1-q2", "Draft two bullet points for the board deck.",
              "- Revenue grew 9% quarter over quarter, led by renewals.\n- Churn fell to its lowest level in two years.",
              ago: 6_900),
          ]
        case "fixture-3":
          turns = [
            done(
              "fixture-3-q1", "What can I cook with chickpeas and spinach?",
              "A quick **chana saag**: saute onion and garlic, add spices, then the chickpeas and spinach. Serve with rice.",
              ago: 90_000),
            done(
              "fixture-3-q2", "Make it vegan.",
              "It already is, as long as you skip the cream. Use coconut milk for richness.", ago: 89_000),
          ]
        default:
          turns = [
            done(
              "\(sessionID)-q1", "Give me a one line summary.", "Here is a short summary of this conversation.",
              ago: 4_000)
          ]
        }
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

    /// A canned gallery whose items open generated local files (`FixtureMediaFiles`), so the image detail and both
    /// players work offline.
    private struct FixtureMediaAPI: MediaAPI {
      private static let now = Date()

      private static let all: [MediaItem] = (0..<24).map { index in
        let kind: MediaKind = index % 5 == 3 ? .video : (index % 5 == 4 ? .audio : .image)
        let (ext, mime) =
          switch kind {
          case .image: ("png", "image/png")
          case .video: ("mp4", "video/mp4")
          case .audio: ("wav", "audio/wav")
          }
        return MediaItem(
          id: "fixture-media-\(index)", kind: kind, fileName: "generation-\(index).\(ext)", mimeType: mime,
          createdAt: now.addingTimeInterval(-Double(index) * 3_600))
      }

      func listMedia(kind: MediaKind?, page: Int, limit: Int) async throws -> MediaPage {
        let matching = Self.all.filter { kind == nil || $0.kind == kind }
        let start = (page - 1) * limit
        guard start < matching.count else { return MediaPage(items: [], hasMore: false) }
        let slice = matching[start..<min(start + limit, matching.count)]
        var items: [MediaItem] = []
        for item in slice { items.append(await Self.withContent(item)) }
        return MediaPage(items: items, hasMore: start + limit < matching.count)
      }

      func media(id: String) async throws -> MediaItem {
        guard let item = Self.all.first(where: { $0.id == id }) else { throw APIError.notFound }
        return await Self.withContent(item)
      }

      private static func withContent(_ item: MediaItem) async -> MediaItem {
        let index = Self.all.firstIndex(of: item) ?? 0
        return await FixtureMediaFiles.shared.withContent(item, index: index)
      }
    }

    /// Streams a canned reply as cumulative `streamed_chat_completion` frames, so the chat screen can be
    /// exercised without a server.
    actor FixtureRealtime: RealtimeClient {
      private var listeners: [UUID: AsyncStream<RealtimeEvent>.Continuation] = [:]

      private var scheduledTurns: Set<String> = []
      private var settledTurns: Set<String> = []

      var connectionState: RealtimeConnectionState { .connected }

      /// Settles a turn that the transcript lists as working: a done frame arrives `delay` after the first
      /// call. Returns whether it has settled already, so a reload after that lists it as done.
      func scheduleWorkingTurn(
        questID: String, sessionID: String, prompt: String, reply: String, delay: Duration = .seconds(5)
      ) -> Bool {
        if scheduledTurns.insert(questID).inserted {
          Task {
            try? await Task.sleep(for: delay)
            emit(questID, sessionID, prompt, reply, "done")
            settledTurns.insert(questID)
          }
        }
        return settledTurns.contains(questID)
      }

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
        // Status lines are what the Live Activity shows as its stage; the first ones arrive before any text.
        let stages = ["Reading your message", "Searching your notes", "Drafting a reply"]
        Task {
          emit(questID, sessionID, prompt, "", "running", stages[0])
          try? await Task.sleep(for: .milliseconds(1_500))
          for count in stride(from: 1, through: words.count, by: 2) {
            let stage = stages[min(count / 2, stages.count - 1)]
            emit(questID, sessionID, prompt, words.prefix(count).joined(separator: " "), "running", stage)
            try? await Task.sleep(for: .milliseconds(450))
          }
          emit(questID, sessionID, prompt, reply, "done")
        }
      }

      private func emit(
        _ questID: String, _ sessionID: String, _ prompt: String, _ reply: String, _ status: String,
        _ statusMessage: String = ""
      ) {
        let quest: JSONObject = [
          "id": .string(questID), "sessionId": .string(sessionID), "prompt": .string(prompt),
          "reply": .string(reply), "status": .string(status), "type": "message", "creditsUsed": 12,
        ]
        let frame = ActionFrame(
          action: ChatQuestFrame.action,
          payload: [
            "action": .string(ChatQuestFrame.action), "quest": .object(quest), "statusMessage": .string(statusMessage),
          ])
        for listener in listeners.values { listener.yield(.frame(frame)) }
      }
    }
  }
#endif
