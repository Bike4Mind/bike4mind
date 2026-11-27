import B4MKit
import SwiftUI

/// The notebook history, pushed on the home screen (`AppShellView` registers the destinations). The view
/// model is the app-wide one in `AppServices.sessionsModel`, shared with the drawer.
struct SessionsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    SessionsListScreen(model: services.sessionsModel, captureJobs: services.capture.jobs)
  }
}

private struct SessionsListScreen: View {
  let model: SessionsViewModel
  @State private var captureJobs: CaptureJobsViewModel
  @Environment(AppServices.self) private var services
  @Environment(\.scenePhase) private var scenePhase
  @State private var renaming: SessionSummary?
  @State private var renameText = ""
  @State private var deleting: SessionSummary?

  init(model: SessionsViewModel, captureJobs: any CaptureJobTracking) {
    self.model = model
    _captureJobs = State(initialValue: CaptureJobsViewModel(tracker: captureJobs))
  }

  var body: some View {
    content
      .background(Tokens.Palette.background)
      .navigationTitle("Notebooks")
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
      .alert("Rename Notebook", isPresented: isPresenting($renaming), presenting: renaming) { session in
        TextField("Name", text: $renameText)
          .accessibilityIdentifier("sessions-rename-field")
        Button("Cancel", role: .cancel) {}
        Button("Save") {
          let name = renameText
          Task { await model.rename(session.id, to: name) }
        }
        .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("sessions-rename-save-btn")
      }
      .confirmationDialog(
        "Delete this notebook?", isPresented: isPresenting($deleting), titleVisibility: .visible,
        presenting: deleting
      ) { session in
        Button("Delete", role: .destructive) {
          Task { await model.delete(session.id) }
        }
        .accessibilityIdentifier("sessions-delete-confirm-btn")
      } message: { session in
        Text("\"\(session.title)\" and its messages will be deleted everywhere. This can't be undone.")
      }
  }

  private func isPresenting(_ item: Binding<SessionSummary?>) -> Binding<Bool> {
    Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })
  }

  private func beginRename(_ session: SessionSummary) {
    renameText = session.name
    renaming = session
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.sessions.isEmpty) {
    case (.idle, true), (.loading, true):
      ProgressView("Loading notebooks")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("sessions-loading")
    case (.failed(let error), true):
      ContentUnavailableView {
        Label("Couldn't load notebooks", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("sessions-retry-btn")
      }
    case (.loaded, true):
      ContentUnavailableView {
        Label("No notebooks yet", systemImage: "bubble.left.and.bubble.right")
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

  /// Pops back to the Chat home, which is where a new conversation starts.
  private func startConversation() {
    services.navigator.apply(.compose(ComposeRequest(target: .newConversation)))
  }

  private var sessionList: some View {
    List {
      Group {
        if case .failed(let error) = model.state {
          InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
        }
        if let error = model.mutationError {
          InlineErrorBanner(message: error.message, actionTitle: "Dismiss") { model.dismissMutationError() }
            .accessibilityIdentifier("sessions-mutation-error")
        }
        ForEach(model.sessions) { session in
          NavigationLink(value: SessionsDestination.session(session)) {
            SessionRow(session: session)
          }
          // Not role: .destructive, which removes the row before the confirmation is answered.
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", systemImage: "trash") { deleting = session }
              .tint(Tokens.Palette.destructive)
              .accessibilityIdentifier("sessions-row-delete-btn")
              .disabled(model.isMutating(session.id))
            Button("Rename", systemImage: "pencil") { beginRename(session) }
              .tint(Tokens.Palette.brand)
              .accessibilityIdentifier("sessions-row-rename-btn")
              .disabled(model.isMutating(session.id))
          }
          .contextMenu {
            Button("Rename", systemImage: "pencil") { beginRename(session) }
              .disabled(model.isMutating(session.id))
            Button("Delete", systemImage: "trash", role: .destructive) { deleting = session }
              .disabled(model.isMutating(session.id))
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
      Text(session.title)
        .font(Tokens.Typography.headline)
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
  var actionTitle = "Retry"
  let action: () -> Void

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
    Button(actionTitle, action: action)
      .font(Tokens.Typography.caption.weight(.semibold))
      .buttonStyle(.borderless)
      .frame(minHeight: 44)
  }
}
