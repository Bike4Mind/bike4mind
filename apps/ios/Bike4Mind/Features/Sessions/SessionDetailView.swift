import B4MKit
import SwiftUI

/// Read-only transcript of one session. Sending and live streaming arrive with chat (M3), which reuses
/// `MessageBubble` and feeds `TranscriptMessage` from the live stream.
struct SessionDetailView: View {
  let session: SessionSummary
  @Environment(AppServices.self) private var services

  var body: some View {
    TranscriptScreen(session: session, api: services.api)
  }
}

private struct TranscriptScreen: View {
  let session: SessionSummary
  @State private var model: TranscriptViewModel

  init(session: SessionSummary, api: any B4MAPI) {
    self.session = session
    _model = State(initialValue: TranscriptViewModel(sessionID: session.id, api: api))
  }

  var body: some View {
    content
      .navigationTitle(session.name.isEmpty ? "Untitled" : session.name)
      .navigationBarTitleDisplayMode(.inline)
      .background(Tokens.Palette.background)
      .task { await model.load() }
      .refreshable { await model.refresh() }
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.messages.isEmpty) {
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
        "Nothing here yet", systemImage: "text.bubble",
        description: Text("This session has no messages."))
    default:
      transcript
    }
  }

  private var transcript: some View {
    ScrollView {
      LazyVStack(spacing: Tokens.Spacing.m) {
        if case .failed(let error) = model.state {
          InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
        }
        ForEach(model.messages) { message in
          MessageBubble(message: message)
            .task { await model.loadMoreIfNeeded(currentMessage: message) }
        }
        footer
      }
      .padding(.horizontal, Tokens.Spacing.m)
      .padding(.vertical, Tokens.Spacing.s)
    }
    .accessibilityIdentifier("transcript-scroll")
  }

  @ViewBuilder
  private var footer: some View {
    if model.isLoadingMore {
      ProgressView()
    } else if let error = model.loadMoreError {
      InlineErrorBanner(message: error.message) { Task { await model.loadMore() } }
    } else if model.hasMore {
      Button("Load more") { Task { await model.loadMore() } }
        .buttonStyle(.bordered)
    }
  }
}
