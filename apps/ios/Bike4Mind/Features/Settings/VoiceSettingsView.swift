import B4MKit
import SwiftUI

struct VoiceSettingsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    VoiceSettingsContent(catalog: services.voiceCatalog)
  }
}

private struct VoiceSettingsContent: View {
  @State private var model: VoicePickerViewModel
  @Environment(\.scenePhase) private var scenePhase

  init(catalog: VoiceCatalogModel) {
    _model = State(initialValue: VoicePickerViewModel(catalog: catalog, samples: AVVoiceSamplePlayer()))
  }

  var body: some View {
    Form {
      Section {
        row(name: "On-device voice", detail: "Built into iPhone. Works offline.", isSelected: model.selectedID == nil) {
          Task { await model.select(nil) }
        }
        .accessibilityIdentifier("voice-settings-row-on-device")
      } footer: {
        Text("Voice replies are read aloud in the voice you pick here.")
      }
      .listRowBackground(Tokens.Palette.groupedBackground)

      Section {
        if model.isLoading && model.voices.isEmpty {
          ProgressView().frame(maxWidth: .infinity)
        }
        ForEach(model.voices) { voice in
          row(name: voice.name, detail: Self.detail(voice), isSelected: model.selectedID == voice.id) {
            Task { await model.select(voice) }
          } accessory: {
            if model.canPlaySample(voice) { sampleButton(voice) }
          }
          .accessibilityIdentifier("voice-settings-row-\(voice.id)")
        }
      } header: {
        Text("Premium voices")
      } footer: {
        if model.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text("Premium voices are unavailable right now.")
            Button("Retry") { Task { await model.load() } }
              .accessibilityIdentifier("voice-settings-retry-btn")
          }
        }
      }
      .listRowBackground(Tokens.Palette.groupedBackground)
    }
    .brandedListChrome()
    .navigationTitle("Voice")
    .navigationBarTitleDisplayMode(.inline)
    .task { await model.load() }
    .onDisappear { Task { await model.stopSample() } }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { Task { await model.stopSample() } }
    }
  }

  private func row(
    name: String, detail: String?, isSelected: Bool, action: @escaping () -> Void,
    @ViewBuilder accessory: () -> some View = { EmptyView() }
  ) -> some View {
    HStack {
      Button(action: action) {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text(name).foregroundStyle(.primary)
            if let detail { Text(detail).font(Tokens.Typography.caption).foregroundStyle(.secondary) }
          }
          Spacer()
          if isSelected {
            Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityAddTraits(isSelected ? .isSelected : [])
      accessory()
    }
  }

  private func sampleButton(_ voice: VoiceOption) -> some View {
    let isPlaying = model.playingSampleID == voice.id
    return Button {
      Task { await model.toggleSample(voice) }
    } label: {
      Image(systemName: isPlaying ? "stop.circle" : "play.circle").font(.title3)
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(isPlaying ? "Stop sample of \(voice.name)" : "Play sample of \(voice.name)")
    .accessibilityIdentifier("voice-settings-sample-btn-\(voice.id)")
  }

  private static func detail(_ voice: VoiceOption) -> String? {
    let parts = [voice.labels["accent"], voice.labels["gender"]].compactMap { $0?.capitalized }
    return parts.isEmpty ? nil : parts.joined(separator: ", ")
  }
}
