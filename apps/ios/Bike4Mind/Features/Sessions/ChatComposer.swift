import B4MKit
import SwiftUI

/// The message bar shared by a session's chat and the new-conversation screen, styled like the web
/// composer at phone width (SessionBottom): a full-width panel bar with a hairline top edge, the field,
/// dictation, the optional agent-run toggle and a solid send square. Draft and send state stay with the
/// owning view model.
struct ChatComposer: View {
  @Binding var draft: String
  var isFocused: FocusState<Bool>.Binding
  let canSend: Bool
  /// Non-nil only when the account can start agent runs; `nil` hides the toggle and its hint.
  var agentRun: Binding<Bool>?
  let onDictate: () -> Void
  let onSend: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .title) private var iconSize: CGFloat = 24
  @ScaledMetric(relativeTo: .title) private var sendSize: CGFloat = 32
  @ScaledMetric(relativeTo: .title) private var sendGlyphSize: CGFloat = 14

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      if agentRun?.wrappedValue == true {
        Label("Agent run: leave anytime, progress shows on your Lock Screen", systemImage: "bolt.circle.fill")
          .font(Tokens.Typography.meta)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .accessibilityIdentifier("chat-composer-agent-hint")
      }
      row
    }
    .padding(Tokens.Spacing.s + Tokens.Spacing.xs)
    .background {
      Tokens.Palette.panel
        .overlay(alignment: .top) { Rectangle().fill(Tokens.Palette.borderSolid).frame(height: 1) }
        .ignoresSafeArea(edges: .bottom)
    }
  }

  /// At accessibility text sizes the field takes the full width and the buttons move to a row beneath it;
  /// beside three scaled buttons the placeholder would truncate to a few letters.
  private var row: some View {
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
        HStack(alignment: .bottom, spacing: Tokens.Spacing.xs) {
          messageField
          micButton
          agentButton
          sendButton
        }
      }
    }
  }

  private var micButton: some View {
    Button(action: onDictate) {
      icon("mic")
    }
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Dictate a message")
    .accessibilityIdentifier("chat-composer-mic")
  }

  @ViewBuilder
  private var agentButton: some View {
    if let agentRun {
      Button {
        agentRun.wrappedValue.toggle()
      } label: {
        icon(agentRun.wrappedValue ? "bolt.fill" : "bolt")
      }
      .frame(minWidth: 44, minHeight: 44)
      .accessibilityLabel("Run as agent")
      .accessibilityHint("Runs in the background and shows progress on your Lock Screen")
      .accessibilityValue(agentRun.wrappedValue ? "On" : "Off")
      .accessibilityIdentifier("chat-composer-agent-toggle")
    }
  }

  private var messageField: some View {
    TextField(
      "Message", text: $draft,
      prompt: Text("Type your message here...").foregroundStyle(Tokens.Palette.composerPlaceholder.opacity(0.75)),
      axis: .vertical
    )
    .lineLimit(1...6)
    .font(Tokens.Typography.body)
    .foregroundStyle(Tokens.Palette.primaryText)
    .focused(isFocused)
    .padding(.horizontal, Tokens.Spacing.xs)
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .submitLabel(.send)
    .onSubmit { if canSend { onSend() } }
    .accessibilityIdentifier("chat-composer-field")
  }

  /// Web SessionToolbar: a solid primary 32pt square at radius sm with a small arrow.
  private var sendButton: some View {
    Button(action: onSend) {
      Image(systemName: "arrow.up")
        .font(.system(size: sendGlyphSize, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: sendSize, height: sendSize)
        .background(
          Tokens.Palette.sendButton.opacity(canSend ? 1 : 0.4),
          in: RoundedRectangle(cornerRadius: Tokens.Radius.sm, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!canSend)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Send")
    .accessibilityIdentifier("chat-composer-send")
  }

  private func icon(_ name: String) -> some View {
    Image(systemName: name)
      .font(.system(size: iconSize))
      .foregroundStyle(Tokens.Palette.secondaryText)
  }
}
