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
      agentRuns: services.agentRuns)
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
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .title) private var composerIconSize: CGFloat = 32

  init(
    session: SessionSummary, api: any B4MAPI, realtime: any RealtimeClient, activities: any QuestActivityTracking,
    agentRuns: any AgentRunStarting
  ) {
    self.session = session
    _title = State(initialValue: session.name)
    _model = State(
      initialValue: ChatViewModel(
        sessionID: session.id, api: api, realtime: realtime, title: session.name, activities: activities,
        agentRuns: agentRuns))
  }

  var body: some View {
    content
      .navigationTitle(title.isEmpty ? "Untitled" : title)
      .navigationBarTitleDisplayMode(.inline)
      .background(Tokens.Palette.background)
      .safeAreaInset(edge: .bottom) { composer }
      .inAppSafari(url: $linkedPage)
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
        LazyVStack(spacing: Tokens.Spacing.m) {
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
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.s)
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
        })
      .onChange(of: model.messages.last) { _, last in
        guard let last else { return }
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) }
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
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      if model.sendsAsAgentRun {
        Label("Agent run: leave anytime, progress shows on your Lock Screen", systemImage: "bolt.circle.fill")
          .font(Tokens.Typography.meta)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .accessibilityIdentifier("chat-composer-agent-hint")
      }
      composerRow
    }
    .padding(.horizontal, Tokens.Spacing.m)
    .padding(.vertical, Tokens.Spacing.s)
    .background(.bar)
  }

  /// At accessibility text sizes the field takes the full width and the buttons move to a row beneath it;
  /// beside three scaled buttons the placeholder would truncate to a few letters.
  private var composerRow: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
          messageField
          HStack(spacing: Tokens.Spacing.s) {
            micButton
            agentButton
            Spacer(minLength: 0)
            sendButton
          }
        }
      } else {
        HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
          micButton
          agentButton
          messageField
          sendButton
        }
      }
    }
  }

  private var micButton: some View {
    Button {
      isRecordingVoice = true
    } label: {
      composerIcon("mic.circle")
    }
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Dictate a message")
    .accessibilityIdentifier("chat-composer-mic")
  }

  @ViewBuilder
  private var agentButton: some View {
    if model.canRunAgent {
      Button {
        model.sendsAsAgentRun.toggle()
      } label: {
        composerIcon(model.sendsAsAgentRun ? "bolt.circle.fill" : "bolt.circle")
      }
      .frame(minWidth: 44, minHeight: 44)
      .accessibilityLabel("Run as agent")
      .accessibilityHint("Runs in the background and shows progress on your Lock Screen")
      .accessibilityValue(model.sendsAsAgentRun ? "On" : "Off")
      .accessibilityIdentifier("chat-composer-agent-toggle")
    }
  }

  private var messageField: some View {
    TextField("Message", text: $model.draft, axis: .vertical)
      .lineLimit(1...6)
      .focused($composerFocused)
      .padding(.horizontal, Tokens.Spacing.m)
      .padding(.vertical, Tokens.Spacing.s + 2)
      .background(Tokens.Palette.groupedBackground)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous)
          .strokeBorder(Tokens.Palette.divider, lineWidth: 1)
      }
      .submitLabel(.send)
      .onSubmit(send)
      .accessibilityIdentifier("chat-composer-field")
  }

  private var sendButton: some View {
    Button(action: send) {
      composerIcon("arrow.up.circle.fill")
    }
    .disabled(!model.canSend)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Send")
    .accessibilityIdentifier("chat-composer-send")
  }

  private func composerIcon(_ name: String) -> some View {
    Image(systemName: name)
      .font(.system(size: composerIconSize))
      .symbolRenderingMode(.hierarchical)
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
