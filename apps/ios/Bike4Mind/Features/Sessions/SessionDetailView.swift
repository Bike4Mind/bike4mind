import B4MKit
import SwiftUI

/// One session's conversation: the stored transcript, live streaming replies and the composer.
/// All protocol and merge logic lives in `ChatViewModel`; this view only renders it.
struct SessionDetailView: View {
  let session: SessionSummary
  @Environment(AppServices.self) private var services

  var body: some View {
    ChatScreen(session: session, api: services.api, realtime: services.realtime)
  }
}

private struct ChatScreen: View {
  let session: SessionSummary
  @Environment(AppServices.self) private var services
  @State private var model: ChatViewModel
  @FocusState private var composerFocused: Bool

  init(session: SessionSummary, api: any B4MAPI, realtime: any RealtimeClient) {
    self.session = session
    _model = State(initialValue: ChatViewModel(sessionID: session.id, api: api, realtime: realtime))
  }

  var body: some View {
    content
      .navigationTitle(session.name.isEmpty ? "Untitled" : session.name)
      .navigationBarTitleDisplayMode(.inline)
      .background(Tokens.Palette.background)
      .safeAreaInset(edge: .bottom) { composer }
      .task { await model.load() }
      .task { await model.listen() }
      .onDisappear { model.stop() }
      .onChange(of: model.turns) { _, turns in
        services.chatTurnsChanged(sessionID: session.id, title: session.name, turns: turns)
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
    HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
      TextField("Message", text: $model.draft, axis: .vertical)
        .lineLimit(1...6)
        .focused($composerFocused)
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.s + 2)
        .background(Tokens.Palette.assistantBubble)
        .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous))
        .submitLabel(.send)
        .onSubmit(send)
        .accessibilityIdentifier("chat-composer-field")
      Button(action: send) {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 32))
          .symbolRenderingMode(.hierarchical)
      }
      .disabled(!model.canSend)
      .accessibilityLabel("Send")
      .accessibilityIdentifier("chat-composer-send")
    }
    .padding(.horizontal, Tokens.Spacing.m)
    .padding(.vertical, Tokens.Spacing.s)
    .background(.bar)
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
    HStack(spacing: Tokens.Spacing.s) {
      Label("Not sent. \(error.message)", systemImage: "exclamationmark.circle")
        .font(Tokens.Typography.meta)
        .foregroundStyle(Tokens.Palette.destructive)
      if error.isRetryable || error == .malformedResponse {
        Button("Retry", action: retry)
          .font(Tokens.Typography.meta.weight(.semibold))
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .accessibilityIdentifier("chat-send-failure")
  }
}
