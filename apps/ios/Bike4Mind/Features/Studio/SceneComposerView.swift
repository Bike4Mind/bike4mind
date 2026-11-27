import B4MKit
import SwiftUI

/// A Scene: one video and one music track from the person's own gallery, composed into a single shareable clip.
/// Opened from "Add music..." on a video or "Put on a video..." on a track; the item it starts from fills its slot.
struct SceneComposerView: View {
  @State private var model: SceneComposerViewModel
  @Environment(\.dismiss) private var dismiss
  /// Called once the compose job started, so the caller can bring its progress tile into view.
  private let onStarted: () -> Void

  init(draft: SceneDraft, context: StudioEditContext, onStarted: @escaping () -> Void) {
    _model = State(
      initialValue: SceneComposerViewModel(
        draft: draft, api: context.api, media: context.media, tracker: context.tracker))
    self.onStarted = onStarted
  }

  var body: some View {
    NavigationStack {
      Form {
        slot(title: "Picture", kind: .video, picked: model.draft.video)
        slot(title: "Soundtrack", kind: .audio, picked: model.draft.audio)
        fitSection
        coverSection
        Section {
          TextField("Title (optional)", text: $model.draft.title)
            .accessibilityIdentifier("scene-title-field")
        } footer: {
          Text("The Scene runs as long as the video. Composing is free.")
        }
        if let message = errorMessage {
          Section {
            Text(message)
              .foregroundStyle(Tokens.Palette.destructive)
              .accessibilityIdentifier("scene-error")
          }
        }
      }
      .navigationTitle("New Scene")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .accessibilityIdentifier("scene-cancel-btn")
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.isSubmitting {
            ProgressView()
          } else {
            Button("Compose") { Task { await submit() } }
              .disabled(!model.canSubmit)
              .accessibilityHint(model.draft.issue ?? "Starts composing the Scene")
              .accessibilityIdentifier("scene-compose-btn")
          }
        }
      }
      .task { await model.load() }
    }
    .accessibilityIdentifier("scene-sheet")
  }

  private var errorMessage: String? {
    switch model.error {
    case .refused(let failure): failure.message
    case .rejected(_, let message): message
    case .api(let error): error.message
    case nil: nil
    }
  }

  private func submit() async {
    guard await model.submit() else { return }
    dismiss()
    onStarted()
  }

  /// The slot the item started in shows that item; the open slot lists the person's files of that kind.
  @ViewBuilder
  private func slot(title: String, kind: MediaKind, picked: MediaItem?) -> some View {
    Section(title) {
      if model.openSlot == kind {
        choices(kind: kind, picked: picked)
      } else if let picked {
        row(picked, selected: true)
      }
    }
  }

  @ViewBuilder
  private func choices(kind: MediaKind, picked: MediaItem?) -> some View {
    switch model.partners {
    case .loading:
      ProgressView().frame(maxWidth: .infinity)
    case .failed:
      Text("Couldn't load your \(kind == .video ? "videos" : "music").")
        .foregroundStyle(Tokens.Palette.secondaryText)
    case .loaded(let items) where items.isEmpty:
      Text(kind == .video ? "No videos yet. Create one first." : "No music yet. Create a song first.")
        .foregroundStyle(Tokens.Palette.secondaryText)
        .accessibilityIdentifier("scene-partner-empty")
    case .loaded(let items):
      ForEach(items) { item in
        Button {
          model.pick(item)
        } label: {
          row(item, selected: item.id == picked?.id)
        }
        .accessibilityIdentifier("scene-partner-\(item.id)")
      }
    }
  }

  private func row(_ item: MediaItem, selected: Bool) -> some View {
    HStack(spacing: Tokens.Spacing.s) {
      Image(systemName: item.kind == .video ? "film" : "waveform")
        .foregroundStyle(Tokens.Palette.secondaryText)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.displayTitle).lineLimit(1)
        if let prompt = item.prompt, !prompt.isEmpty {
          Text(prompt)
            .font(Tokens.Typography.meta)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      if selected {
        Image(systemName: "checkmark").foregroundStyle(.tint)
      }
    }
    .contentShape(Rectangle())
    .foregroundStyle(Tokens.Palette.primaryText)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(item.kind == .video ? "Video" : "Music"), \(item.displayTitle)")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var fitSection: some View {
    Section {
      Picker("Fit", selection: $model.draft.fit) {
        ForEach(SceneAudioFit.allCases, id: \.self) { fit in Text(fit.title).tag(fit) }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("scene-fit")
      Toggle("Fade out at the end", isOn: $model.draft.fades)
        .accessibilityIdentifier("scene-fade-toggle")
    } header: {
      Text("Music")
    } footer: {
      Text(
        model.draft.fit == .trim
          ? "The music is cut where the video ends." : "The music repeats until the video ends.")
    }
  }

  private var coverSection: some View {
    Section {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: Tokens.Spacing.s) {
          coverTile(nil)
          if case .loaded(let images) = model.covers {
            ForEach(images) { image in coverTile(image) }
          }
        }
        .padding(.vertical, Tokens.Spacing.xs)
      }
    } header: {
      Text("Cover art (optional)")
    }
  }

  private func coverTile(_ image: MediaItem?) -> some View {
    let selected = model.draft.cover?.id == image?.id
    return Button {
      if let image { model.pick(image) } else { model.draft.cover = nil }
    } label: {
      ZStack {
        Tokens.Palette.groupedBackground
        if let image {
          AsyncImage(url: image.url) { phase in
            if let loaded = phase.image { loaded.resizable().scaledToFill() }
          }
        } else {
          Text("None").font(Tokens.Typography.meta).foregroundStyle(Tokens.Palette.secondaryText)
        }
      }
      .frame(width: 64, height: 64)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
          .strokeBorder(selected ? Tokens.Palette.brand : .clear, lineWidth: 3)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(image.map { "Cover, \($0.displayTitle)" } ?? "No cover")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(image.map { "scene-cover-\($0.id)" } ?? "scene-cover-none")
  }
}
