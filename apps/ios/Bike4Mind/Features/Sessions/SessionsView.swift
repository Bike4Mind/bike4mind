import B4MKit
import SwiftUI

/// Entry point for the Sessions tab. Owns the view model so it survives pushes onto the stack.
struct SessionsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    SessionsListScreen(api: services.api, cache: services.sessionListCache, captureJobs: services.capture.jobs)
      .navigationDestination(for: SessionSummary.self) { session in
        SessionDetailView(session: session)
          // Opening a conversation is the first moment the app has shown the user value, so this is
          // when the one-time system notification prompt appears.
          .task { await services.push.userDidReachValueMoment() }
      }
  }
}

private struct SessionsListScreen: View {
  @State private var model: SessionsViewModel
  @State private var captureJobs: CaptureJobsViewModel
  @Environment(AppServices.self) private var services
  @Environment(\.scenePhase) private var scenePhase

  init(api: any B4MAPI, cache: any SessionListCache, captureJobs: any CaptureJobTracking) {
    _model = State(initialValue: SessionsViewModel(api: api, cache: cache))
    _captureJobs = State(initialValue: CaptureJobsViewModel(tracker: captureJobs))
  }

  var body: some View {
    content
      .background(Tokens.Palette.background)
      .navigationTitle("Sessions")
      .toolbar {
        if captureJobs.isVisible {
          ToolbarItem(placement: .topBarLeading) { CaptureJobsChip(model: captureJobs) }
        }
        ToolbarItem(placement: .primaryAction) { CaptureMenu() }
        ToolbarItem(placement: .primaryAction) { newConversationButton }
      }
      .task { await model.load() }
      .task { await captureJobs.observe() }
      .onChange(of: scenePhase) { _, phase in
        // The share extension queues jobs in another process, which the engine's stream cannot see.
        if phase == .active { Task { await captureJobs.reload() } }
      }
      .refreshable { await model.refresh() }
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.sessions.isEmpty) {
    case (.idle, true), (.loading, true):
      ProgressView("Loading sessions")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("sessions-loading")
    case (.failed(let error), true):
      ContentUnavailableView {
        Label("Couldn't load sessions", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("sessions-retry-btn")
      }
    case (.loaded, true):
      ContentUnavailableView {
        Label("No sessions yet", systemImage: "bubble.left.and.bubble.right")
      } description: {
        Text("Conversations you start in Bike4Mind will appear here.")
      } actions: {
        Button("New Conversation", action: startConversation)
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("sessions-empty-new-btn")
      }
    default:
      sessionList
    }
  }

  private var newConversationButton: some View {
    Button(action: startConversation) {
      Label("New Conversation", systemImage: "square.and.pencil")
    }
    .accessibilityLabel("New conversation")
    .accessibilityIdentifier("sessions-new-conversation-btn")
  }

  private func startConversation() {
    services.navigator.apply(.compose(ComposeRequest(target: .newConversation)))
  }

  private var sessionList: some View {
    List {
      Group {
        if case .failed(let error) = model.state {
          InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
        }
        ForEach(model.sessions) { session in
          NavigationLink(value: session) {
            SessionRow(session: session)
          }
          .task { await model.loadMoreIfNeeded(currentItem: session) }
        }
        if model.isLoadingMore {
          ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
        }
        if let error = model.loadMoreError {
          InlineErrorBanner(message: error.message) { Task { await model.loadMore() } }
        }
      }
      .listRowBackground(Color.clear)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .accessibilityIdentifier("sessions-list")
  }
}

private struct SessionRow: View {
  let session: SessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      Text(session.name.isEmpty ? "Untitled" : session.name)
        .font(.headline)
        .foregroundStyle(Tokens.Palette.primaryText)
        .lineLimit(2)
      // At accessibility text sizes the time and model stack instead of truncating.
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Tokens.Spacing.s) { details(separator: true) }
        VStack(alignment: .leading, spacing: 0) { details(separator: false) }
      }
      .font(Tokens.Typography.caption)
      .foregroundStyle(Tokens.Palette.secondaryText)
    }
    .padding(.vertical, Tokens.Spacing.xs)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func details(separator: Bool) -> some View {
    Text(RelativeTime.describe(session.lastUpdated))
    if let model = session.lastUsedModel {
      if separator { Text("\u{00B7}").accessibilityHidden(true) }
      Text(model).lineLimit(1)
    }
  }
}

struct InlineErrorBanner: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Tokens.Spacing.s) { content }
      VStack(alignment: .leading, spacing: Tokens.Spacing.xs) { content }
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private var content: some View {
    HStack(spacing: Tokens.Spacing.s) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tokens.Palette.warning)
        .accessibilityHidden(true)
      Text(message).font(Tokens.Typography.caption)
    }
    Button("Retry", action: retry)
      .font(Tokens.Typography.caption.weight(.semibold))
      .buttonStyle(.borderless)
      .frame(minHeight: 44)
  }
}
