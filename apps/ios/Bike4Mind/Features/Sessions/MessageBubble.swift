import B4MKit
import SwiftUI

/// One chat bubble. Takes a `TranscriptMessage` and nothing else, so the live chat screen renders
/// streaming replies with the same view by swapping the message's text.
struct MessageBubble: View {
  let message: TranscriptMessage
  @Environment(\.openWebPage) private var openWebPage
  @Environment(AuthController.self) private var auth

  private var isUser: Bool { message.role == .user }

  var body: some View {
    HStack(alignment: .bottom, spacing: 0) {
      if isUser { Spacer(minLength: Tokens.Spacing.xxl) }
      VStack(alignment: isUser ? .trailing : .leading, spacing: Tokens.Spacing.xs) {
        bubble
          .contextMenu { if !message.text.isEmpty { contextActions } }
        footer
      }
      if !isUser { Spacer(minLength: Tokens.Spacing.xxl) }
    }
    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(message.accessibilityLabel())
  }

  @ViewBuilder
  private var contextActions: some View {
    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
    ShareLink(item: message.text) { Label("Share", systemImage: "square.and.arrow.up") }
  }

  @ViewBuilder
  private var bubble: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
      if message.text.isEmpty {
        // A turn still working has no text yet; the badge below says why.
        Text(" ")
      } else {
        Text(MarkdownText.attributed(message.text))
          .textSelection(.enabled)
      }
      if let action = message.pendingAction {
        PendingActionCard(action: action, openWeb: { openWebPage(auth.environment.baseURL) })
      }
    }
    .padding(.horizontal, Tokens.Spacing.m)
    .padding(.vertical, Tokens.Spacing.s + 2)
    .foregroundStyle(Tokens.Palette.primaryText)
    .background(isUser ? Tokens.Palette.userBubble : Tokens.Palette.assistantBubble)
    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous))
    .overlay {
      if let outline {
        RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous)
          .strokeBorder(outline.opacity(0.6), lineWidth: 1)
      }
    }
    .frame(maxWidth: Tokens.Layout.bubbleMaxWidth, alignment: isUser ? .trailing : .leading)
  }

  @ViewBuilder
  private var footer: some View {
    HStack(spacing: Tokens.Spacing.s) {
      if let badge = message.badge {
        StatusBadge(badge: badge)
        if case .outOfCredits = badge {
          Button("Manage credits") { openWebPage(auth.environment.baseURL) }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("message-manage-credits-btn")
        }
      }
      Text(RelativeTime.describe(message.createdAt))
      if !isUser, let credits = message.creditsUsed {
        Text("\u{00B7}").accessibilityHidden(true)
        Text("\(CreditsViewModel.formatted(credits)) credits")
      }
    }
    .font(Tokens.Typography.meta)
    .foregroundStyle(Tokens.Palette.secondaryText)
  }

  /// Refused and failed turns are outlined so the error reads as an error, not as a reply.
  private var outline: Color? {
    switch message.badge {
    case .failed: Tokens.Palette.destructive
    case .outOfCredits: Tokens.Palette.warning
    default: nil
    }
  }
}

struct StatusBadge: View {
  let badge: TranscriptMessage.Badge

  var body: some View {
    Label(title, systemImage: symbol)
      .font(Tokens.Typography.meta.weight(.semibold))
      .foregroundStyle(tint)
      .labelStyle(.titleAndIcon)
  }

  private var title: String { badge.title }

  private var symbol: String {
    switch badge {
    case .queued: "clock"
    case .working: "ellipsis.circle"
    case .stopped: "stop.circle"
    case .failed, .outOfCredits: "exclamationmark.triangle"
    case .awaitingApproval: "hand.raised"
    }
  }

  private var tint: Color {
    switch badge {
    case .queued, .working, .stopped: Tokens.Palette.secondaryText
    case .failed: Tokens.Palette.destructive
    case .awaitingApproval, .outOfCredits: Tokens.Palette.warning
    }
  }
}

/// Shows which tool is waiting and with what. Read-only: answering an approval is not part of the public
/// API contract yet (see `ApprovalState.canRespondInApp`), so the card points to the web.
private struct PendingActionCard: View {
  let action: PendingAction
  let openWeb: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      Label(action.tool, systemImage: "wrench.and.screwdriver")
        .font(Tokens.Typography.caption.weight(.semibold))
      TimelineView(.periodic(from: .now, by: 30)) { context in
        let hasLapsed = action.hasLapsed(at: context.date)
        VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
          Text(hasLapsed ? "This request expired." : "Approve or deny this on Bike4Mind for the web.")
            .font(Tokens.Typography.meta)
            .foregroundStyle(Tokens.Palette.secondaryText)
          if !hasLapsed {
            Button("Review on the web", action: openWeb)
              .font(Tokens.Typography.meta.weight(.semibold))
              .buttonStyle(.borderless)
              .accessibilityIdentifier("message-review-on-web-btn")
          }
        }
      }
      ForEach(action.parameters.sorted(by: { $0.key < $1.key }), id: \.key) { name, value in
        Text("\(name): \(value)")
          .font(Tokens.Typography.meta.monospaced())
          .foregroundStyle(Tokens.Palette.secondaryText)
          .lineLimit(2)
      }
    }
    .padding(Tokens.Spacing.s)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Tokens.Palette.background.opacity(0.6))
    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous))
    .accessibilityIdentifier("message-pending-action")
  }
}

private struct OpenWebPageKey: EnvironmentKey {
  static let defaultValue: @MainActor (URL) -> Void = { _ in }
}

extension EnvironmentValues {
  /// Opens a page in the in-app Safari sheet owned by the enclosing screen (see `View.inAppSafari`).
  var openWebPage: @MainActor (URL) -> Void {
    get { self[OpenWebPageKey.self] }
    set { self[OpenWebPageKey.self] = newValue }
  }
}
