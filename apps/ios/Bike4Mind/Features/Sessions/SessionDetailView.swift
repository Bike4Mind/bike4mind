import B4MKit
import SwiftUI

/// One session's conversation: the stored transcript, live streaming replies and the composer.
/// All protocol and merge logic lives in `ChatViewModel`; this view only renders it.
struct SessionDetailView: View {
  let session: SessionSummary
  @Environment(AppServices.self) private var services

  var body: some View {
    ChatScreen(
      session: session, api: services.api, realtime: services.realtime, activities: services.questActivities,
      agentRuns: services.agentRuns, firstTurn: services.navigator.takeOpeningTurn(forSession: session.id))
  }
}

private struct ChatScreen: View {
  let session: SessionSummary
  @Environment(AppServices.self) private var services
  @State private var model: ChatViewModel
  /// The list row's name, or one looked up after load for a session opened by id (push, link, intent).
  @State private var title: String
  @FocusState private var composerFocused: Bool
  @State private var isRecordingVoice = false
  /// A web link tapped in the transcript, shown in the in-app browser.
  @State private var linkedPage: URL?

  init(
    session: SessionSummary, api: any B4MAPI, realtime: any RealtimeClient, activities: any QuestActivityTracking,
    agentRuns: any AgentRunStarting, firstTurn: QuestTurn?
  ) {
    self.session = session
    _title = State(initialValue: session.name)
    _model = State(
      initialValue: ChatViewModel(
        sessionID: session.id, api: api, realtime: realtime, title: session.name, activities: activities,
        agentRuns: agentRuns, firstTurn: firstTurn))
  }

  var body: some View {
    content
      .navigationTitle(title.isEmpty ? "Untitled" : title)
      .navigationBarTitleDisplayMode(.inline)
      .background(Tokens.Palette.background)
      .safeAreaInset(edge: .bottom) { composer }
      .inAppSafari(url: $linkedPage)
      .environment(\.openWebPage, { linkedPage = $0 })
      .sheet(isPresented: $isRecordingVoice) {
        VoiceRecorderPanel(
          onTranscript: { text in
            model.draft = model.draft.isEmpty ? text : model.draft + " " + text
            isRecordingVoice = false
          },
          onCancel: { isRecordingVoice = false })
      }
      .task {
        await model.load()
        await resolveTitleIfNeeded()
      }
      .task { await model.listen() }
      .onDisappear { model.stop() }
      .onChange(of: model.turns) { _, turns in
        services.chatTurnsChanged(sessionID: session.id, title: title, turns: turns)
      }
      .onChange(of: settledLiveTurnCount) { _, _ in services.refreshWidgetCredits() }
      .onChange(of: services.navigator.composeRequest, initial: true) { _, _ in takeComposeRequest() }
      .refreshable { await model.refresh() }
      .sensoryFeedback(trigger: model.hapticTrigger) { _, trigger in
        trigger.map(Self.feedback(for:))
      }
  }

  /// Live turns that reached a terminal state; each one spent credits, so the Credits widget re-reads the balance.
  private var settledLiveTurnCount: Int {
    model.liveTurns.filter { $0.status?.isTerminal ?? false }.count
  }

  private func resolveTitleIfNeeded() async {
    guard title.isEmpty,
      let name = await SessionLookup.name(
        forSession: session.id, api: services.api, cache: services.sessionListCache, turns: model.transcript.turns)
    else { return }
    title = name
    // The widget row was recorded without a name when the turns first loaded.
    services.chatTurnsChanged(sessionID: session.id, title: name, turns: model.turns)
  }

  /// An App Intent (Start quest) asked for this session's composer: prefill and focus it.
  private func takeComposeRequest() {
    guard let request = services.navigator.takeComposeRequest(forSession: session.id) else { return }
    if !request.draft.isEmpty { model.draft = request.draft }
    composerFocused = true
  }

  private static func feedback(for trigger: HapticTrigger) -> SensoryFeedback {
    switch trigger.haptic {
    case .started: .impact(weight: .light)
    case .needsAttention: .warning
    case .finished: .success
    case .failed: .error
    }
  }

  @ViewBuilder
  private var content: some View {
    let transcript = model.transcript
    switch (transcript.state, model.messages.isEmpty) {
    case (.idle, true), (.loading, true):
      ProgressView("Loading conversation")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("transcript-loading")
    case (.failed(let error), true):
      ContentUnavailableView {
        Label("Couldn't load this conversation", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        if error.isRetryable {
          Button("Try Again") { Task { await model.refresh() } }
            .buttonStyle(.borderedProminent)
        }
      }
    case (.loaded, true):
      ContentUnavailableView(
        "Start the conversation", systemImage: "text.bubble",
        description: Text("Send a message below."))
    default:
      transcriptList
    }
  }

  private var transcriptList: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: Tokens.Spacing.l) {
          if case .failed(let error) = model.transcript.state {
            InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
          }
          ForEach(model.messages) { message in
            MessageBubble(message: message)
              .id(message.id)
              .task { await model.transcript.loadMoreIfNeeded(currentMessage: message) }
            if message.role == .user, let failure = model.sendFailure(forQuestID: message.questID) {
              SendFailureRow(error: failure) { Task { await model.retry(questID: message.questID) } }
            }
          }
          footer
        }
        .frame(maxWidth: Tokens.Layout.transcriptMaxWidth)
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.s)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .defaultScrollAnchor(.bottom)
      // Links in model output never reach the system directly (see `TranscriptLinkPolicy`).
      .environment(
        \.openURL,
        OpenURLAction { url in
          guard let page = TranscriptLinkPolicy.webPage(for: url) else { return .discarded }
          linkedPage = page
          return .handled
        }
      )
      .onChange(of: model.messages.last) { _, last in
        // From iOS 18 the bottom anchor also holds through size changes. An animated scrollTo racing a
        // reply's height change can leave the lazy stack blank until the next scroll, so it is not animated.
        guard #unavailable(iOS 18.0), let last else { return }
        proxy.scrollTo(last.id, anchor: .bottom)
      }
      .accessibilityIdentifier("transcript-scroll")
    }
  }

  @ViewBuilder
  private var footer: some View {
    let transcript = model.transcript
    if transcript.isLoadingMore {
      ProgressView()
    } else if let error = transcript.loadMoreError {
      InlineErrorBanner(message: error.message) { Task { await transcript.loadMore() } }
    } else if transcript.hasMore {
      Button("Load more") { Task { await transcript.loadMore() } }
        .buttonStyle(.bordered)
    }
  }

  private var composer: some View {
    ChatComposer(
      draft: $model.draft, isFocused: $composerFocused, canSend: model.canSend,
      agentRun: model.canRunAgent ? $model.sendsAsAgentRun : nil,
      onDictate: { isRecordingVoice = true }, onSend: send)
  }

  private func send() {
    guard model.canSend else { return }
    Task { await model.send() }
  }
}

/// Shown under a message the server never accepted.
private struct SendFailureRow: View {
  let error: APIError
  let retry: () -> Void

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Tokens.Spacing.s) { content }
      VStack(alignment: .trailing, spacing: Tokens.Spacing.xs) { content }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .accessibilityIdentifier("chat-send-failure")
  }

  @ViewBuilder
  private var content: some View {
    Label("Not sent. \(error.message)", systemImage: "exclamationmark.circle")
      .font(Tokens.Typography.meta)
      .foregroundStyle(Tokens.Palette.destructive)
    if error.isRetryable || error == .malformedResponse {
      Button("Retry", action: retry)
        .font(Tokens.Typography.meta.weight(.semibold))
        .frame(minHeight: 44)
    }
  }
}
