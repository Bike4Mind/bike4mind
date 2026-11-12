import B4MKit
import SwiftUI

/// The message bar shared by a session's chat and the new-conversation screen: rounded field, dictation,
/// optional agent-run toggle and send. Draft and send state stay with the owning view model.
struct ChatComposer: View {
  @Binding var draft: String
  var isFocused: FocusState<Bool>.Binding
  let canSend: Bool
  /// Non-nil only when the account can start agent runs; `nil` hides the toggle and its hint.
  var agentRun: Binding<Bool>?
  let onDictate: () -> Void
  let onSend: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .title) private var iconSize: CGFloat = 32

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
    .padding(.horizontal, Tokens.Spacing.m)
    .padding(.vertical, Tokens.Spacing.s)
    .background(.bar)
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
        HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
          micButton
          agentButton
          messageField
          sendButton
        }
      }
    }
  }

  private var micButton: some View {
    Button(action: onDictate) {
      icon("mic.circle")
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
        icon(agentRun.wrappedValue ? "bolt.circle.fill" : "bolt.circle")
      }
      .frame(minWidth: 44, minHeight: 44)
      .accessibilityLabel("Run as agent")
      .accessibilityHint("Runs in the background and shows progress on your Lock Screen")
      .accessibilityValue(agentRun.wrappedValue ? "On" : "Off")
      .accessibilityIdentifier("chat-composer-agent-toggle")
    }
  }

  private var messageField: some View {
    TextField("Message", text: $draft, axis: .vertical)
      .lineLimit(1...6)
      .focused(isFocused)
      .padding(.horizontal, Tokens.Spacing.m)
      .padding(.vertical, Tokens.Spacing.s + 2)
      .background(Tokens.Palette.groupedBackground)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Tokens.Radius.bubble, style: .continuous)
          .strokeBorder(Tokens.Palette.divider, lineWidth: 1)
      }
      .submitLabel(.send)
      .onSubmit { if canSend { onSend() } }
      .accessibilityIdentifier("chat-composer-field")
  }

  private var sendButton: some View {
    Button(action: onSend) {
      icon("arrow.up.circle.fill")
    }
    .disabled(!canSend)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Send")
    .accessibilityIdentifier("chat-composer-send")
  }

  private func icon(_ name: String) -> some View {
    Image(systemName: name)
      .font(.system(size: iconSize))
      .symbolRenderingMode(.hierarchical)
  }
}
