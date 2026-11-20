import B4MKit
import SwiftUI

/// The assistant brief: a server-composed summary opened from a push or the drawer. What needs the user comes
/// first, because that is the point of it; an approval opens the conversation that holds the existing card.
struct BriefView: View {
  @Environment(AppServices.self) private var services
  let briefID: String?

  var body: some View {
    BriefScreen(api: services.briefs, briefID: briefID)
  }
}

private struct BriefScreen: View {
  @State private var model: BriefViewModel
  @Environment(AppServices.self) private var services

  init(api: any BriefAPI, briefID: String?) {
    _model = State(initialValue: BriefViewModel(api: api, briefID: briefID))
  }

  var body: some View {
    content
      .background(Tokens.Palette.background)
      .navigationTitle("Brief")
      .navigationBarTitleDisplayMode(.inline)
      .task {
        await model.load()
        services.refreshWidgetPendingDecisions()
      }
      .onDisappear { model.cancel() }
      .refreshable {
        await model.refresh()
        services.refreshWidgetPendingDecisions()
      }
      .toolbar {
        if let brief = model.brief, brief.status == .ready, !brief.isEmpty {
          ToolbarItem(placement: .topBarTrailing) {
            Button("New brief", systemImage: "arrow.clockwise") { model.startCompose() }
              .disabled(model.isComposing)
              .accessibilityIdentifier("brief-new-btn")
          }
        }
      }
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.brief) {
    case (.loading, nil):
      ProgressView("Loading brief")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("brief-loading")
    case (.failed(let error), nil):
      ContentUnavailableView {
        Label("Couldn't load the brief", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("brief-retry-btn")
      }
    case (_, nil):
      ContentUnavailableView {
        Label("No brief yet", systemImage: "text.badge.checkmark")
      } description: {
        Text("Your assistant can summarize what happened, what it handled and what needs you.")
      } actions: {
        Button("Compose a brief") { model.startCompose() }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("brief-compose-btn")
      }
    case (_, let brief?):
      briefContent(brief)
    }
  }

  @ViewBuilder
  private func briefContent(_ brief: Brief) -> some View {
    switch brief.status {
    case .composing:
      composing
    case .failed:
      ContentUnavailableView {
        Label("The brief didn't finish", systemImage: "exclamationmark.triangle")
      } description: {
        Text("Something went wrong while putting it together.")
      } actions: {
        Button("Try Again") { model.startCompose() }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("brief-failed-retry-btn")
      }
    case .unknown:
      ContentUnavailableView(
        "Update to read this brief", systemImage: "arrow.down.app",
        description: Text("This brief needs a newer version of Bike4Mind."))
    case .ready:
      ready(brief)
    }
  }

  /// Scrollable so pull-to-refresh works here, with an explicit button for the same reason: a poll that timed
  /// out or failed must be recoverable without leaving the screen.
  private var composing: some View {
    ScrollView {
      VStack(spacing: Tokens.Spacing.m) {
        if case .failed(let error) = model.state {
          Label("Couldn't check on the brief", systemImage: "wifi.exclamationmark")
            .font(.headline)
          Text(error.message)
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .multilineTextAlignment(.center)
          checkAgainButton
        } else if model.composeTimedOut {
          Label("Still working on it", systemImage: "clock")
            .font(.headline)
          Text("This is taking longer than usual. Check again in a moment.")
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .multilineTextAlignment(.center)
          checkAgainButton
        } else {
          ProgressView("Putting your brief together")
        }
      }
      .padding(Tokens.Spacing.m)
      .frame(maxWidth: .infinity)
      .containerRelativeFrame(.vertical)
    }
    .accessibilityIdentifier("brief-composing")
  }

  private var checkAgainButton: some View {
    Button("Check again") { Task { await model.refresh() } }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("brief-check-again-btn")
  }

  @ViewBuilder
  private func ready(_ brief: Brief) -> some View {
    if brief.isEmpty {
      ContentUnavailableView {
        Label("All quiet", systemImage: "checkmark.circle")
      } description: {
        Text("Nothing needs you right now.")
      } actions: {
        Button("Compose a brief") { model.startCompose() }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("brief-compose-btn")
      }
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
          if case .failed(let error) = model.state {
            InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
          }
          if let headline = brief.headline, !headline.isEmpty {
            Text(headline)
              .font(.title2.weight(.semibold))
              .foregroundStyle(Tokens.Palette.primaryText)
              .accessibilityAddTraits(.isHeader)
              .accessibilityIdentifier("brief-headline")
          }
          Text(periodText(brief))
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
          decisionsSection(brief.decisions)
          itemsSection("Handled", items: brief.handled, id: "brief-handled-section")
          itemsSection("What happened", items: brief.happened, id: "brief-happened-section")
        }
        .padding(Tokens.Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .accessibilityIdentifier("brief-content")
    }
  }

  private func periodText(_ brief: Brief) -> String {
    let range = brief.periodStart.formatted(date: .abbreviated, time: .shortened)
    return "Since \(range)"
  }

  @ViewBuilder
  private func decisionsSection(_ decisions: [BriefDecision]) -> some View {
    if !decisions.isEmpty {
      section("What needs you", id: "brief-decisions-section") {
        ForEach(decisions) { decision in
          VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Text(decision.text)
              .font(Tokens.Typography.body)
              .foregroundStyle(Tokens.Palette.primaryText)
            if let approval = decision.approval {
              Button("Open approval") { services.navigator.pushSession(id: approval.sessionID) }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Open approval: \(decision.text)")
                .accessibilityIdentifier("brief-open-approval-btn")
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(Tokens.Spacing.m)
          .background(Tokens.Palette.groupedBackground, in: RoundedRectangle(cornerRadius: Tokens.Radius.md))
          .accessibilityIdentifier("brief-decision-row")
        }
      }
    }
  }

  @ViewBuilder
  private func itemsSection(_ title: String, items: [BriefItem], id: String) -> some View {
    if !items.isEmpty {
      section(title, id: id) {
        ForEach(items) { item in
          Text(item.text)
            .font(Tokens.Typography.body)
            .foregroundStyle(Tokens.Palette.primaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("brief-item-row")
        }
      }
    }
  }

  private func section<Content: View>(
    _ title: String, id: String, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
      Text(title)
        .font(.headline)
        .foregroundStyle(Tokens.Palette.primaryText)
        .accessibilityAddTraits(.isHeader)
      content()
    }
    .accessibilityIdentifier(id)
  }
}
