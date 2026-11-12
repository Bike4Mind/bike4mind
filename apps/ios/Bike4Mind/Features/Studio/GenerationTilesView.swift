import B4MKit
import SwiftUI

/// A strip of what Studio is making right now: progress while it runs, the result or the reason once it settles.
struct GenerationTilesView: View {
  let tracker: GenerationTracker
  @State private var cancelError: String?

  var body: some View {
    if !tracker.generations.isEmpty {
      VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: Tokens.Spacing.s) {
            ForEach(tracker.generations) { generation in
              GenerationTile(generation: generation) {
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
  let onCancel: () -> Void
  let onDismiss: () -> Void

  private let side: CGFloat = 76
  @State private var showsFailure = false

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      ZStack {
        RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous)
          .fill(Tokens.Palette.groupedBackground)
        preview
      }
      .frame(width: side, height: side)
      .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.control, style: .continuous))
      .overlay(alignment: .topTrailing) { cornerButton }
      Text(generation.handle.prompt)
        .font(Tokens.Typography.meta)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .lineLimit(1)
        .frame(width: side, alignment: .leading)
    }
    .contentShape(Rectangle())
    .onTapGesture { if case .failed = generation.phase { showsFailure = true } }
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
