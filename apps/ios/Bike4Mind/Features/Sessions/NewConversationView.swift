import B4MKit
import SwiftUI

/// The app's home: the start of a conversation that does not exist yet, with a greeting, starter chips
/// and a docked composer. It is the root of the navigation stack, so the drawer's destinations and a sent
/// conversation are pushed on top of it. App Intents land here with a prefilled draft; nothing is sent until
/// the user taps Send.
struct NewConversationView: View {
  @Environment(AppServices.self) private var services
  @State private var model: NewConversationViewModel
  @State private var profile: AccountProfile?
  @State private var isRecordingVoice = false
  @FocusState private var focused: Bool

  init(api: any B4MAPI, activities: any QuestActivityTracking) {
    _model = State(initialValue: NewConversationViewModel(api: api, activities: activities))
  }

  var body: some View {
    VStack(spacing: Tokens.Spacing.m) {
      Spacer(minLength: 0)
      if model.isSending {
        // The server creates the session before it answers, which takes a few seconds on a cold start.
        ProgressView("Starting your chat...")
          .font(Tokens.Typography.caption)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .accessibilityIdentifier("new-conversation-sending")
      } else if model.draft.isEmpty {
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
      ToolbarItem(placement: .topBarLeading) { menuButton }
      ToolbarItem(placement: .topBarTrailing) { profileButton }
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
    .task { profile = await services.accountProfile() }
    .onChange(of: services.navigator.composeRequest, initial: true) { _, _ in takeComposeRequest() }
    // A field left focused under a pushed screen is refocused on return, and that refocus does not lift the
    // safeAreaInset composer above the keyboard: drop focus whenever home is covered.
    .onChange(of: services.navigator.isShowing(.home)) { _, isShowing in
      if !isShowing { focused = false }
    }
    .onChange(of: services.navigator.isDrawerOpen) { _, isOpen in
      if isOpen { focused = false }
    }
  }

  private var menuButton: some View {
    Button {
      services.navigator.isDrawerOpen = true
    } label: {
      Label("Menu", systemImage: "line.3.horizontal")
    }
    .accessibilityLabel("Menu")
    .accessibilityIdentifier("home-menu-btn")
  }

  private var profileButton: some View {
    Button {
      services.navigator.apply(.settings)
    } label: {
      AccountAvatar(initial: profile?.initial, diameter: 32)
    }
    .accessibilityLabel("Profile and settings")
    .accessibilityIdentifier("home-profile-btn")
  }

  /// Web NotebookSplash on a phone: the 48pt brand mark over an h3 greeting.
  private var greeting: some View {
    VStack(spacing: Tokens.Spacing.s + Tokens.Spacing.xs) {
      Image("LaunchMark")
        .resizable()
        .scaledToFit()
        .frame(width: Tokens.Spacing.xxl, height: Tokens.Spacing.xxl)
        .accessibilityHidden(true)
      Text(StartGreeting.headline(at: Date(), firstName: profile?.firstName))
        .font(Tokens.Typography.greeting)
        .foregroundStyle(Tokens.Palette.primaryText)
        .multilineTextAlignment(.center)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("new-conversation-greeting")
      Text(StartGreeting.subline)
        .font(Tokens.Typography.caption)
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
            .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
            .overlay {
              RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
                .strokeBorder(Tokens.Palette.borderSoft, lineWidth: 1)
            }
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

  /// A new-conversation request (an App Intent, or New chat in the drawer or notebook list) focuses the
  /// composer. A non-empty draft replaces whatever was typed, so a second Siri request is not dropped.
  private func takeComposeRequest() {
    guard let request = services.navigator.takeNewConversationRequest() else { return }
    if !request.draft.isEmpty { model.draft = request.draft }
    focused = true
  }

  private func send() {
    guard model.canSend else { return }
    focused = false
    Task {
      // The model clears the draft on success, so back from the new session lands on the greeting again.
      guard let sessionID = await model.send() else { return }
      services.navigator.openNewConversation(sessionID: sessionID, firstTurn: model.startedTurn)
    }
  }
}
