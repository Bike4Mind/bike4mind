import B4MKit
import SwiftUI

/// The hands-free conversation screen: one big state indicator, the words being said and heard, and the few
/// controls that matter when a thumb is the only input (mute, stop the reply, end). Everything it shows is
/// also the VoiceOver reading order, since the user may never look at it.
struct VoiceConversationView: View {
  @Environment(AppServices.self) private var services
  @Environment(AuthController.self) private var auth
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase
  @ScaledMetric(relativeTo: .largeTitle) private var orbSize: CGFloat = 132

  let request: VoiceRequest
  @State private var model: VoiceConversationModel?
  /// The prompt is raised by itself once per lock; a cancelled one is not raised again until Unlock is tapped.
  @State private var promptedUnlock = false

  var body: some View {
    VStack(spacing: Tokens.Spacing.l) {
      topBar
      Spacer(minLength: 0)
      if let model {
        orb(for: model)
        status(for: model)
        words(for: model)
      }
      Spacer(minLength: 0)
      if let model { controls(for: model) }
      if auth.state == .locked {
        Button("Unlock") { Task { await auth.unlock() } }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .accessibilityIdentifier("voice-conversation-unlock-btn")
      }
    }
    .padding(Tokens.Spacing.m)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Tokens.Palette.background)
    // Nothing is loaded, read out or listened for until signed in with App Lock lifted (Listen can arrive from a notification).
    .task(id: auth.state == .signedIn) {
      if auth.state == .signedIn { await run() }
    }
    // This cover sits above LockedView, whose own unlock prompt ran while the app was still in the background.
    .task(id: scenePhase) {
      guard scenePhase == .active, auth.state == .locked, !promptedUnlock else { return }
      promptedUnlock = true
      await auth.unlock()
    }
    .onChange(of: auth.state) { _, state in
      if state != .locked { promptedUnlock = false }
    }
    .onDisappear { Task { await model?.stop() } }
    .onChange(of: model?.phase) { _, phase in announce(phase) }
  }

  // MARK: - Pieces

  private var topBar: some View {
    HStack {
      Spacer()
      Button("Done") { end() }
        .font(Tokens.Typography.body.weight(.semibold))
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityHint("Ends the voice conversation")
        .accessibilityIdentifier("voice-conversation-done-btn")
    }
  }

  private func orb(for model: VoiceConversationModel) -> some View {
    let color = Self.color(for: model.phase)
    return Button {
      Task { await model.interrupt() }
    } label: {
      ZStack {
        Circle().fill(color.opacity(0.18))
        Circle().fill(color).padding(orbSize * 0.18)
        Image(systemName: Self.symbol(for: model.phase))
          .font(.system(size: orbSize * 0.3, weight: .semibold))
          .foregroundStyle(.white)
          .symbolEffect(.pulse, isActive: pulses(model.phase) && !reduceMotion)
      }
      .frame(width: orbSize, height: orbSize)
    }
    // Never disabled: a disabled button dims its whole label, and interrupt() ignores phases with nothing to stop.
    .buttonStyle(.plain)
    .accessibilityLabel(Self.label(for: model.phase))
    .accessibilityHint(canInterrupt(model.phase) ? "Double tap to stop the reply and speak" : "")
    .accessibilityAddTraits(.updatesFrequently)
    .accessibilityIdentifier("voice-conversation-orb")
  }

  private func status(for model: VoiceConversationModel) -> some View {
    VStack(spacing: Tokens.Spacing.xs) {
      Text(Self.label(for: model.phase))
        .font(Tokens.Typography.greeting)
        .foregroundStyle(Tokens.Palette.primaryText)
        .accessibilityIdentifier("voice-conversation-phase")
      if case .failed(let error) = model.phase {
        Text(error.message)
          .font(Tokens.Typography.caption)
          .foregroundStyle(Tokens.Palette.destructive)
          .multilineTextAlignment(.center)
        if error == .permissionDenied {
          Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
          }
          .accessibilityIdentifier("voice-conversation-settings-btn")
        }
      }
      if let notice = model.notice {
        Label(notice, systemImage: "info.circle")
          .font(Tokens.Typography.caption)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .multilineTextAlignment(.center)
      }
    }
  }

  private func words(for model: VoiceConversationModel) -> some View {
    VStack(spacing: Tokens.Spacing.s) {
      if !model.liveTranscript.isEmpty {
        Text(model.liveTranscript)
          .font(Tokens.Typography.body)
          .foregroundStyle(Tokens.Palette.primaryText)
          .accessibilityLabel("You said: \(model.liveTranscript)")
          .accessibilityIdentifier("voice-conversation-live-transcript")
      } else if let last = model.exchanges.last {
        VStack(spacing: Tokens.Spacing.xs) {
          Text(last.userText)
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
          if !last.replyText.isEmpty {
            Text(last.replyText)
              .font(Tokens.Typography.body)
              .foregroundStyle(Tokens.Palette.primaryText)
              .lineLimit(8)
          }
          if let credits = last.creditsUsed, credits > 0 {
            Text("Credits used: \(CreditsViewModel.formatted(credits))")
              .font(Tokens.Typography.meta)
              .foregroundStyle(Tokens.Palette.secondaryText)
              .accessibilityIdentifier("voice-conversation-credits")
          }
        }
        // The reply is spoken aloud, so VoiceOver need not read it a second time on every update.
        .accessibilityElement(children: .combine)
      }
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: Tokens.Layout.readableWidth)
  }

  private func controls(for model: VoiceConversationModel) -> some View {
    HStack(spacing: Tokens.Spacing.xl) {
      Button {
        Task { await model.setMuted(!model.isMuted) }
      } label: {
        Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
          .font(.title2)
          .frame(width: 56, height: 56)
          .background(Circle().fill(Tokens.Palette.panel))
      }
      .accessibilityLabel("Microphone")
      .accessibilityValue(model.isMuted ? "Muted" : "On")
      .accessibilityIdentifier("voice-conversation-mute-btn")

      if case .paused = model.phase {
        Button("Resume") { Task { await model.resume() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("voice-conversation-resume-btn")
      } else if case .failed = model.phase {
        Button("Try again") { Task { await model.start() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("voice-conversation-retry-btn")
      } else {
        Button {
          Task { await model.interrupt() }
        } label: {
          Image(systemName: "stop.fill")
            .font(.title2)
            .frame(width: 56, height: 56)
            .background(Circle().fill(Tokens.Palette.panel))
        }
        .disabled(!canInterrupt(model.phase))
        .accessibilityLabel("Stop reply")
        .accessibilityIdentifier("voice-conversation-stop-btn")
      }
    }
    .foregroundStyle(Tokens.Palette.primaryText)
  }

  // MARK: - Behavior

  /// Runs in the view's task, which is cancelled when the screen goes away: a brief still loading then never
  /// gets a model, and one dismissed while starting is stopped again.
  private func run() async {
    guard model == nil else { return }
    var opening: [String] = []
    var context: String?
    var session: BriefVoiceSession?
    if let briefID = request.briefID {
      let auth = auth
      let made = BriefVoiceSession(
        briefID: briefID, api: services.briefs, pendingActions: services.pendingActions,
        canAnswer: { auth.state == .signedIn && UIApplication.shared.applicationState == .active })
      session = made
      (opening, context) = await made.prepare()
    }
    let voiceID = await services.voiceCatalog.premiumVoice()
    // Done may have been tapped during the lookup; onDisappear then had no model to stop.
    guard !Task.isCancelled, model == nil else { return }
    var handler: VoiceConversationModel.UtteranceHandler?
    if let session {
      handler = { utterance in await session.handle(utterance) }
    }
    let model = Self.makeModel(
      request: request, services: services, voiceID: voiceID, opening: opening, context: context,
      bargeInWords: session == nil ? [] : BriefVoiceSession.bargeInWords, answerPhrases: session?.answerPhrases ?? [],
      handler: handler)
    self.model = model
    await model.start()
    if Task.isCancelled {
      await model.stop()
      self.model = nil
    }
  }

  private func end() {
    let sessionID = model?.sessionID
    services.navigator.endVoiceConversation(startedSessionID: sessionID)
  }

  private func canInterrupt(_ phase: VoiceConversationModel.Phase) -> Bool {
    switch phase {
    case .sending, .streaming, .speaking: true
    default: false
    }
  }

  private func pulses(_ phase: VoiceConversationModel.Phase) -> Bool {
    phase == .listening || phase == .speaking
  }

  /// Only the states the user cannot hear are announced; speech already covers the rest.
  private func announce(_ phase: VoiceConversationModel.Phase?) {
    switch phase {
    case .paused, .failed: if let phase { AccessibilityNotification.Announcement(Self.label(for: phase)).post() }
    default: break
    }
  }

  private static func makeModel(
    request: VoiceRequest, services: AppServices, voiceID: String?, opening: [String], context: String?,
    bargeInWords: Set<String>, answerPhrases: Set<String>, handler: VoiceConversationModel.UtteranceHandler?
  ) -> VoiceConversationModel {
    let model: VoiceConversationModel
    #if DEBUG
      // The Simulator has no usable speech input: B4M_VOICE_SCRIPTED_SPEECH=1 scripts the utterance while the
      // send and the streamed reply still go through the real API and socket. B4M_VOICE_SCRIPT="approve|yes"
      // replaces the scripted utterances, one per turn.
      let environment = ProcessInfo.processInfo.environment
      if FixtureServices.isEnabled || environment["B4M_VOICE_SCRIPTED_SPEECH"] == "1" {
        let script = environment["B4M_VOICE_SCRIPT"].map { $0.split(separator: "|").map(String.init) }
        model = VoiceFixtures.makeModel(
          target: request.target, api: services.api, realtime: services.realtime, bargeInWords: bargeInWords,
          answerPhrases: answerPhrases, opening: opening,
          firstTurnContext: context, utteranceHandler: handler,
          script: script ?? ["What can you help me with today"])
        return model
      }
    #endif
    model = VoiceConversationModel(
      target: request.target, api: services.api, realtime: services.realtime, listener: SFSpeechListener(),
      speaker: makeSpeaker(services: services, voiceID: voiceID), audioSession: AVVoiceAudioSession(),
      bargeInWords: bargeInWords, answerPhrases: answerPhrases, opening: opening, firstTurnContext: context,
      utteranceHandler: handler)
    model.onTurnSent = { [transcriptCache = services.transcriptCache] id in transcriptCache.remove(sessionID: id) }
    return model
  }

  /// The picked premium voice when there is one, else on-device speech; the premium one falls back on its own.
  private static func makeSpeaker(services: AppServices, voiceID: String?) -> any SpeechSpeaking {
    guard let voiceID else { return AVSpeechSpeaker() }
    return ServerSpeechSpeaker(
      wire: services.voiceAPI, voiceID: voiceID, fallback: AVSpeechSpeaker(), player: AVAudioClipPlayer())
  }

  private static func label(for phase: VoiceConversationModel.Phase) -> String {
    switch phase {
    case .idle: "Starting"
    case .listening: "Listening"
    case .sending: "Sending"
    case .streaming: "Thinking"
    case .speaking: "Speaking"
    case .paused(.interrupted): "Paused by another app or call"
    case .paused(.outputLost): "Paused: audio device disconnected"
    case .failed: "Voice mode stopped"
    }
  }

  private static func symbol(for phase: VoiceConversationModel.Phase) -> String {
    switch phase {
    case .listening: "waveform"
    case .sending, .streaming: "ellipsis"
    case .speaking: "speaker.wave.2.fill"
    case .paused: "pause.fill"
    case .idle, .failed: "mic.slash"
    }
  }

  private static func color(for phase: VoiceConversationModel.Phase) -> Color {
    switch phase {
    case .listening: Tokens.Palette.brand
    case .sending, .streaming: Tokens.Palette.secondaryText
    case .speaking: Tokens.Palette.sendButton
    case .paused, .idle: Tokens.Palette.secondaryText
    case .failed: Tokens.Palette.destructive
    }
  }
}
