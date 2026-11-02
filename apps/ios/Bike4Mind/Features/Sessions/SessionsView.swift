import B4MKit
import SwiftUI

/// Entry point for the Sessions tab. Owns the view model so it survives pushes onto the stack.
struct SessionsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    SessionsListScreen(api: services.api, cache: services.sessionListCache)
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

  init(api: any B4MAPI, cache: any SessionListCache) {
    _model = State(initialValue: SessionsViewModel(api: api, cache: cache))
  }

  var body: some View {
    content
      .navigationTitle("Sessions")
      .toolbar { ToolbarItem(placement: .primaryAction) { CaptureMenu() } }
      .task { await model.load() }
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
      ContentUnavailableView(
        "No sessions yet", systemImage: "bubble.left.and.bubble.right",
        description: Text("Conversations you start in Bike4Mind will appear here."))
    default:
      sessionList
    }
  }

  private var sessionList: some View {
    List {
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
    .listStyle(.plain)
    .accessibilityIdentifier("sessions-list")
  }
}

private struct SessionRow: View {
  let session: SessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      Text(session.name.isEmpty ? "Untitled" : session.name)
        .font(.headline)
        .lineLimit(2)
      HStack(spacing: Tokens.Spacing.s) {
        Text(RelativeTime.describe(session.lastUpdated))
        if let model = session.lastUsedModel {
          Text("\u{00B7}").accessibilityHidden(true)
          Text(model).lineLimit(1)
        }
      }
      .font(Tokens.Typography.caption)
      .foregroundStyle(Tokens.Palette.secondaryText)
    }
    .padding(.vertical, Tokens.Spacing.xs)
    .accessibilityElement(children: .combine)
  }
}

struct InlineErrorBanner: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    HStack(spacing: Tokens.Spacing.s) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tokens.Palette.warning)
      Text(message).font(Tokens.Typography.caption)
      Spacer(minLength: 0)
      Button("Retry", action: retry).font(Tokens.Typography.caption.weight(.semibold)).buttonStyle(.borderless)
    }
    .accessibilityElement(children: .combine)
  }
}
