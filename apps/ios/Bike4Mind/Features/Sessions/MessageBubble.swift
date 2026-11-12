import B4MKit
import SwiftUI

/// One transcript message, styled like the web session view: the user's prompt is a right-aligned
/// bubble (web UserPrompt), the assistant's reply an unframed full-width block (web PromptReplies).
/// Takes a `TranscriptMessage` and nothing else, so the live chat screen renders streaming replies
/// with the same view by swapping the message's text.
struct MessageBubble: View {
  let message: TranscriptMessage
  @Environment(\.openWebPage) private var openWebPage
  @Environment(AuthController.self) private var auth

  private var isUser: Bool { message.role == .user }

  var body: some View {
    VStack(alignment: isUser ? .trailing : .leading, spacing: Tokens.Spacing.xs) {
      if isUser {
        promptBubble
      } else {
        reply
      }
      footer
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

  private var promptBubble: some View {
    TrailingFractionLayout(fraction: Tokens.Layout.promptWidthFraction) { promptText }
  }

  private var promptText: some View {
    Text(MarkdownText.attributed(message.text))
      .font(Tokens.Typography.body)
      .lineSpacing(Tokens.LineSpacing.body)
      .foregroundStyle(Tokens.Palette.primaryText)
      .textSelection(.enabled)
      .padding(.horizontal, Tokens.Spacing.m)
      .padding(.vertical, Tokens.Spacing.s + Tokens.Spacing.xs)
      .background(Tokens.Palette.promptBubble)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
          .strokeBorder(outline ?? Tokens.Palette.borderSoft, lineWidth: 1)
      }
      .contextMenu { if !message.text.isEmpty { contextActions } }
  }

  private var reply: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
      if message.text.isEmpty {
        // A turn still working has no text yet; the badge below says why.
        Text(" ")
      } else {
        ForEach(Array(MarkdownBlock.split(message.text).enumerated()), id: \.offset) { _, block in
          MarkdownBlockView(block: block)
        }
      }
      if let action = message.pendingAction {
        PendingActionCard(action: action, openWeb: { openWebPage(auth.environment.baseURL) })
      }
    }
    .padding(outline == nil ? 0 : Tokens.Spacing.m)
    .overlay {
      if let outline {
        RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
          .strokeBorder(outline.opacity(0.6), lineWidth: 1)
      }
    }
    .contentShape(Rectangle())
    .contextMenu { if !message.text.isEmpty { contextActions } }
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

/// One block of a reply. Every case's text is inline Markdown, rendered by `MarkdownText`.
private struct MarkdownBlockView: View {
  let block: MarkdownBlock

  var body: some View {
    switch block {
    case .prose(let text):
      prose(text)
    case .heading(let level, let text):
      Text(MarkdownText.attributed(text))
        .font(Tokens.Typography.heading(level: level))
        .foregroundStyle(Tokens.Palette.primaryText)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    case .listItem(let marker, let depth, let text):
      HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
        Text(Self.label(marker, depth: depth))
          .font(Tokens.Typography.body)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .monospacedDigit()
        prose(text)
      }
      .padding(.leading, Tokens.Spacing.s + CGFloat(depth) * Tokens.Spacing.l)
    case .quote(let text):
      prose(text)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .padding(.leading, Tokens.Spacing.m)
        .overlay(alignment: .leading) {
          Rectangle().fill(Tokens.Palette.borderSolid).frame(width: 3)
        }
    case .rule:
      Rectangle().fill(Tokens.Palette.divider).frame(height: 1).padding(.vertical, Tokens.Spacing.xs)
    case .code(let language, let code):
      CodeBlockView(language: language, code: code)
    }
  }

  private func prose(_ text: String) -> some View {
    Text(MarkdownText.attributed(text))
      .font(Tokens.Typography.body)
      .lineSpacing(Tokens.LineSpacing.reply)
      .foregroundStyle(Tokens.Palette.readingInk)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Nested bullets alternate disc and circle, as the browser's default list style does.
  private static func label(_ marker: MarkdownBlock.ListMarker, depth: Int) -> String {
    switch marker {
    case .bullet: depth.isMultiple(of: 2) ? "\u{2022}" : "\u{25E6}"
    case .number(let number): number
    }
  }
}

/// Lays its one child out trailing-aligned at no more than `fraction` of the offered width, sized
/// to its content below that (web: `maxWidth: 78%`, `alignSelf: end`).
private struct TrailingFractionLayout: Layout {
  let fraction: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let child = subviews.first else { return .zero }
    let size = child.sizeThatFits(childProposal(proposal.width))
    return CGSize(width: proposal.width ?? size.width, height: size.height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let child = subviews.first else { return }
    let size = child.sizeThatFits(childProposal(bounds.width))
    child.place(
      at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing, proposal: ProposedViewSize(size))
  }

  private func childProposal(_ width: CGFloat?) -> ProposedViewSize {
    ProposedViewSize(width: width.map { $0 * fraction }, height: nil)
  }
}

/// A fenced code block in a reply, framed like the web's (CodeBlockHeader + HighlightedCode): the
/// language and a copy button above a code panel, inside a hairline frame. Long lines scroll
/// sideways instead of wrapping, as on the web.
private struct CodeBlockView: View {
  let language: String?
  let code: String
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
      HStack {
        if let language, !["text", "plain"].contains(language.lowercased()) {
          Text(language)
            .font(Tokens.Typography.codeLabel)
            .foregroundStyle(Tokens.Palette.secondaryText)
        }
        Spacer(minLength: 0)
        Button {
          UIPasteboard.general.string = code
          copied = true
        } label: {
          Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            .labelStyle(.iconOnly)
            .font(Tokens.Typography.meta)
            .frame(minWidth: 44, minHeight: 32)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .sensoryFeedback(.success, trigger: copied) { _, isCopied in isCopied }
        .accessibilityIdentifier("message-code-copy-btn")
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(code)
          .font(Tokens.Typography.code)
          .foregroundStyle(Tokens.Palette.readingInk)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: false)
          .padding(Tokens.Spacing.s + Tokens.Spacing.xs)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Tokens.Palette.codeSurface)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.sm, style: .continuous))
    }
    .padding(.horizontal, Tokens.Spacing.s + Tokens.Spacing.xs)
    .padding(.bottom, Tokens.Spacing.s + Tokens.Spacing.xs)
    .padding(.top, Tokens.Spacing.xs)
    .background(Tokens.Palette.codeFrame.opacity(0.35))
    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
        .strokeBorder(Tokens.Palette.codeFrame, lineWidth: 1)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Code\(language.map { ", \($0)" } ?? ""): \(code)")
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
    .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
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
