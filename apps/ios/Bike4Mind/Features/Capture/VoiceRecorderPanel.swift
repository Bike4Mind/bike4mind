import B4MKit
import SwiftUI

/// Record, transcribe, hand back text. Used by the chat composer (text goes into the draft) and by the lake
/// voice note (text becomes a note file).
struct VoiceRecorderPanel: View {
  @Environment(AppServices.self) private var services
  @State private var model: VoiceCaptureModel?
  @ScaledMetric(relativeTo: .largeTitle) private var recordIconSize: CGFloat = 72
  let onTranscript: (String) -> Void
  let onCancel: () -> Void

  var body: some View {
    NavigationStack {
      VStack(spacing: 24) {
        Spacer()
        if let model { status(for: model) }
        Spacer()
      }
      .padding()
      .frame(maxWidth: .infinity)
      .navigationTitle("Voice Note")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            Task {
              await model?.cancel()
              onCancel()
            }
          }
          .accessibilityIdentifier("voice-cancel-btn")
        }
      }
    }
    .presentationDetents([.medium])
    .task {
      if model == nil { model = Self.makeModel(services: services) }
    }
    .onChange(of: model?.state) { _, state in
      guard case .transcribed = state, let text = model?.consumeTranscript() else { return }
      onTranscript(text)
    }
  }

  @ViewBuilder
  private func status(for model: VoiceCaptureModel) -> some View {
    switch model.state {
    case .idle, .failed:
      if case .failed(let error) = model.state {
        Text(error.message).font(.footnote).foregroundStyle(Tokens.Palette.destructive)
          .multilineTextAlignment(.center)
          .accessibilityIdentifier("voice-error-label")
      }
      recordButton(symbol: "mic.circle.fill", label: "Start recording") { await model.start() }
      Text("Tap to start, tap again to stop.").font(.footnote)
        .foregroundStyle(Tokens.Palette.secondaryText)
    case .recording:
      recordButton(symbol: "stop.circle.fill", label: "Stop recording", tint: Tokens.Palette.destructive) {
        await model.stop()
      }
      Text("Recording").font(.footnote).foregroundStyle(Tokens.Palette.secondaryText)
    case .transcribing, .transcribed:
      ProgressView("Transcribing")
    }
  }

  private func recordButton(
    symbol: String, label: String, tint: Color = .accentColor, action: @escaping () async -> Void
  ) -> some View {
    Button {
      Task { await action() }
    } label: {
      Image(systemName: symbol).font(.system(size: recordIconSize)).foregroundStyle(tint)
    }
    .accessibilityLabel(label)
    .accessibilityIdentifier("voice-record-btn")
  }

  private static func makeModel(services: AppServices) -> VoiceCaptureModel {
    let capture = services.capture
    #if DEBUG
      if FixtureServices.isEnabled {
        return VoiceCaptureModel(
          recorder: CaptureFixtures.recorder, transcriber: capture.transcription, minimumDuration: 0)
      }
    #endif
    return VoiceCaptureModel(recorder: AVAudioRecorderSession(), transcriber: capture.transcription)
  }
}
