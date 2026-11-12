import B4MKit
import SwiftUI

/// A strip of what Studio is making right now: progress while it runs, the result or the reason once it settles.
struct GenerationTilesView: View {
  let tracker: GenerationTracker
  /// "Use these settings": loads a generation's kind, model, prompt and values back into the create bar.
  var settings: StudioCreateViewModel?
  @State private var cancelError: String?

  var body: some View {
    if !tracker.generations.isEmpty {
      VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: Tokens.Spacing.s) {
            ForEach(tracker.generations) { generation in
              GenerationTile(
                generation: generation, summary: settings?.summary(of: generation.handle),
                onUseSettings: settings.map { create in { Task { await create.use(settingsOf: generation.handle) } } }
              ) {
                Task {
                  do { try await tracker.cancel(generation.id) } catch { cancelError = "Couldn't cancel this one." }
                }
              } onDismiss: {
                tracker.dismiss(generation.id)
              }
            }
          }
          .padding(.horizontal, Tokens.Spacing.m)
        }
        if let cancelError {
          Text(cancelError)
            .font(Tokens.Typography.meta)
            .foregroundStyle(Tokens.Palette.destructive)
            .padding(.horizontal, Tokens.Spacing.m)
        }
      }
      .padding(.vertical, Tokens.Spacing.s)
      .background(.bar)
      .accessibilityIdentifier("studio-generations")
    }
  }
}

private struct GenerationTile: View {
  let generation: TrackedGeneration
  /// The values it was made with that differ from the model defaults.
  let summary: String?
  let onUseSettings: (() -> Void)?
  let onCancel: () -> Void
  let onDismiss: () -> Void

  /// Nil when it was made with changed values but its model's controls are not loaded to label them (another kind's
  /// list, or a model since removed): "Model defaults" would be wrong there.
  private var settingsHeader: String? {
    if let summary { return summary }
    return generation.handle.params?.isEmpty ?? true ? "Model defaults" : nil
  }

  private func useSettingsButton(_ action: @escaping () -> Void) -> some View {
    Button("Use these settings", systemImage: "slider.horizontal.3", action: action)
      .accessibilityIdentifier("studio-generation-use-settings")
  }

  private let side: CGFloat = 76
  @State private var showsFailure = false

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      ZStack {
        RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous)
          .fill(Tokens.Palette.groupedBackground)
        preview
      }
      .frame(width: side, height: side)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.md, style: .continuous))
      .overlay(alignment: .topTrailing) { cornerButton }
      Text(generation.handle.prompt)
        .font(Tokens.Typography.meta)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .lineLimit(1)
        .frame(width: side, alignment: .leading)
    }
    .contentShape(Rectangle())
    .onTapGesture { if case .failed = generation.phase { showsFailure = true } }
    .contextMenu {
      // A generation saved before settings were recorded has no model or values to restore.
      if let onUseSettings, generation.handle.modelID != nil {
        if let settingsHeader {
          Section(settingsHeader) { useSettingsButton(onUseSettings) }
        } else {
          useSettingsButton(onUseSettings)
        }
      }
    }
    .alert("Couldn't create this", isPresented: $showsFailure) {
      Button("OK", role: .cancel) {}
    } message: {
      if case .failed(let failure) = generation.phase { Text(failure.message) }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(generation.handle.kind.title): \(generation.handle.prompt), \(statusText)")
    .accessibilityIdentifier("studio-generation-\(generation.id)")
  }

  @ViewBuilder
  private var preview: some View {
    switch generation.phase {
    case .queued:
      ProgressView()
    case .running(let progress):
      if let progress {
        ProgressView(value: min(max(progress, 0), 1)).progressViewStyle(.circular)
      } else {
        ProgressView()
      }
    case .succeeded:
      if generation.handle.kind == .image, let url = generation.resultURLs.first {
        AsyncImage(url: url) { phase in
          if case .success(let image) = phase { image.resizable().scaledToFill() } else { symbol(doneSymbol) }
        }
      } else {
        symbol(doneSymbol)
      }
    case .failed:
      symbol("exclamationmark.triangle").foregroundStyle(Tokens.Palette.warning)
    case .cancelled:
      symbol("xmark.circle")
    }
  }

  @ViewBuilder
  private var cornerButton: some View {
    if generation.phase.isTerminal {
      button("xmark", label: "Dismiss", action: onDismiss)
    } else if generation.handle.isCancellable {
      button("stop.fill", label: "Cancel", action: onCancel)
    }
  }

  private func button(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.caption2.weight(.bold))
        .padding(5)
        .background(.ultraThinMaterial, in: Circle())
    }
    .padding(2)
    .frame(minWidth: 44, minHeight: 44, alignment: .topTrailing)
    .accessibilityLabel(label)
  }

  private var doneSymbol: String {
    switch generation.handle.kind {
    case .image: "photo"
    case .video: "play.rectangle.fill"
    case .music: "waveform"
    }
  }

  private func symbol(_ name: String) -> some View {
    Image(systemName: name).font(.title2).foregroundStyle(Tokens.Palette.secondaryText)
  }

  private var statusText: String {
    switch generation.phase {
    case .queued: "Queued"
    case .running: "In progress"
    case .succeeded: "Done"
    case .failed(let failure): failure.message
    case .cancelled: "Cancelled"
    }
  }
}
