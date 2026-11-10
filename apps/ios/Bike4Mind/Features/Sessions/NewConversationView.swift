import B4MKit
import SwiftUI

/// The start of a conversation that does not exist yet: a greeting, starter chips and a docked composer.
/// Opened from the Sessions tab or by App Intents with a prefilled draft. Nothing is sent until the user
/// taps Send.
struct NewConversationView: View {
  @Environment(AppServices.self) private var services
  @State private var model: NewConversationViewModel
  @State private var firstName: String?
  @State private var isRecordingVoice = false
  @FocusState private var focused: Bool

  init(draft: String, api: any B4MAPI, activities: any QuestActivityTracking) {
    _model = State(initialValue: NewConversationViewModel(draft: draft, api: api, activities: activities))
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: Tokens.Spacing.m) {
        Spacer(minLength: 0)
        if model.draft.isEmpty {
          greeting
          chips
        }
        failures
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Tokens.Spacing.m)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Tokens.Palette.background)
      .contentShape(Rectangle())
      .animation(.easeInOut(duration: 0.2), value: model.draft.isEmpty)
      .safeAreaInset(edge: .bottom) {
        // Must stay in sync with the session chat composer: both render ChatComposer.
        ChatComposer(
          draft: $model.draft, isFocused: $focused, canSend: model.canSend, agentRun: nil,
          onDictate: { isRecordingVoice = true }, onSend: send)
      }
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { services.navigator.dismissNewConversation() }
        }
      }
      .sheet(isPresented: $isRecordingVoice) {
        VoiceRecorderPanel(
          onTranscript: { text in
            model.draft = model.draft.isEmpty ? text : model.draft + " " + text
            isRecordingVoice = false
            focused = true
          },
          onCancel: { isRecordingVoice = false })
      }
      .task { firstName = await services.accountFirstName() }
      .onAppear { focused = true }
    }
  }

  private var greeting: some View {
    VStack(spacing: Tokens.Spacing.xs) {
      Text(StartGreeting.headline(at: Date(), firstName: firstName))
        .font(Tokens.Typography.wordmark)
        .foregroundStyle(Tokens.Palette.primaryText)
        .multilineTextAlignment(.center)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("new-conversation-greeting")
      Text(StartGreeting.subline)
        .font(Tokens.Typography.tagline)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .multilineTextAlignment(.center)
    }
  }

  private var chips: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Tokens.Spacing.s)], spacing: Tokens.Spacing.s) {
      ForEach(StarterChip.allCases) { chip in
        Button {
          choose(chip)
        } label: {
          Label(chip.title, systemImage: chip.symbol)
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .padding(.horizontal, Tokens.Spacing.m)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Tokens.Palette.groupedBackground)
            .clipShape(Capsule())
            .overlay { Capsule().strokeBorder(Tokens.Palette.divider, lineWidth: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chip.title)
        .accessibilityIdentifier("new-conversation-chip-\(chip.rawValue)")
      }
    }
    .frame(maxWidth: Tokens.Layout.readableWidth)
    .padding(.top, Tokens.Spacing.s)
  }

  @ViewBuilder
  private var failures: some View {
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
  }

  private func choose(_ chip: StarterChip) {
    guard let prefill = chip.prefill else {
      isRecordingVoice = true
      return
    }
    model.draft = prefill
    focused = true
  }

  private func send() {
    guard model.canSend else { return }
    Task {
      guard let sessionID = await model.send() else { return }
      services.navigator.dismissNewConversation()
      services.navigator.apply(.session(id: sessionID))
    }
  }
}
