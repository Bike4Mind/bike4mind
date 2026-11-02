import B4MKit
import SwiftUI

/// A composer for a conversation that does not exist yet, opened by App Intents with a prefilled draft.
/// Nothing is sent until the user taps Send.
struct NewConversationView: View {
  @Environment(AppServices.self) private var services
  @State private var model: NewConversationViewModel
  @FocusState private var focused: Bool

  init(draft: String, api: any B4MAPI, activities: any QuestActivityTracking) {
    _model = State(initialValue: NewConversationViewModel(draft: draft, api: api, activities: activities))
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
        TextField("What do you want to ask?", text: $model.draft, axis: .vertical)
          .lineLimit(4...12)
          .focused($focused)
          .padding(Tokens.Spacing.m)
          .background(Tokens.Palette.assistantBubble)
          .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.card, style: .continuous))
          .accessibilityIdentifier("new-conversation-field")
        if let failure = model.failure {
          Label(failure.message, systemImage: "exclamationmark.circle")
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.destructive)
        }
        if let refusal = model.refusal {
          Label(refusal, systemImage: "exclamationmark.circle")
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.destructive)
        }
        Spacer()
      }
      .padding(Tokens.Spacing.m)
      .navigationTitle("New conversation")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { services.navigator.dismissNewConversation() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Send", action: send)
            .disabled(!model.canSend)
            .accessibilityIdentifier("new-conversation-send")
        }
      }
      .onAppear { focused = true }
    }
  }

  private func send() {
    Task {
      guard let sessionID = await model.send() else { return }
      services.navigator.dismissNewConversation()
      services.navigator.apply(.session(id: sessionID))
    }
  }
}
