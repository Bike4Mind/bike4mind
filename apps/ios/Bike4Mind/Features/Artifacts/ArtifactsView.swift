import B4MKit
import SwiftUI

/// The Artifacts list, pushed from the drawer. Reads are owner-only on the server, so team-shared artifacts
/// appear only once opened by id.
struct ArtifactsView: View {
  @Environment(AppServices.self) private var services
  @State private var model: ArtifactsViewModel?

  var body: some View {
    Group {
      if let model {
        ArtifactsListScreen(model: model, api: services.artifacts)
      } else {
        Color.clear
      }
    }
    .background(Tokens.Palette.background)
    .navigationTitle("Artifacts")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      if model == nil { model = ArtifactsViewModel(api: services.artifacts) }
    }
  }
}

private struct ArtifactsListScreen: View {
  let model: ArtifactsViewModel
  let api: any ArtifactsAPI
  /// Pushed with `navigationDestination(item:)`: the shell's stack is bound to a typed `SessionsDestination`
  /// path, so a `NavigationLink(value:)` of another type has nowhere to go.
  @State private var openArtifact: ArtifactSummary?

  var body: some View {
    content
      .navigationDestination(item: $openArtifact) { summary in
        ArtifactDetailView(summary: summary, api: api)
      }
      .task { await model.load() }
      .refreshable { await model.refresh() }
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.artifacts.isEmpty) {
    case (.idle, true), (.loading, true):
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("artifacts-loading")
    case (.failed(let error), true):
      ContentUnavailableView {
        Label("Couldn't load artifacts", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("artifacts-retry-btn")
      }
    case (.loaded, true):
      if model.isFeatureEnabled == false {
        ContentUnavailableView(
          "Artifacts aren't available", systemImage: "shippingbox",
          description: Text("This deployment hasn't turned artifacts on."))
      } else {
        ContentUnavailableView(
          "No artifacts yet", systemImage: "shippingbox",
          description: Text("Pages, diagrams and code your assistant creates will appear here."))
      }
    default:
      list
    }
  }

  private var list: some View {
    List {
      Group {
        if case .failed(let error) = model.state {
          InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
        }
        ForEach(model.artifacts) { artifact in
          Button {
            openArtifact = artifact
          } label: {
            ArtifactRow(artifact: artifact)
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("artifacts-row")
          .task { await model.loadMoreIfNeeded(currentItem: artifact) }
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
    .accessibilityIdentifier("artifacts-list")
  }
}

private struct ArtifactRow: View {
  let artifact: ArtifactSummary

  var body: some View {
    HStack(spacing: Tokens.Spacing.m) {
      Image(systemName: artifact.kind.symbolName)
        .font(.title3)
        .foregroundStyle(Tokens.Palette.brand)
        .frame(width: 32)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
        Text(artifact.displayTitle)
          .font(Tokens.Typography.headline)
          .foregroundStyle(Tokens.Palette.primaryText)
          .lineLimit(2)
        Text("\(artifact.kind.displayName) \u{00B7} \(RelativeTime.describe(artifact.updatedAt))")
          .font(Tokens.Typography.caption)
          .foregroundStyle(Tokens.Palette.secondaryText)
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Tokens.Palette.secondaryText)
        .accessibilityHidden(true)
    }
    .padding(.vertical, Tokens.Spacing.xs)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
  }
}
