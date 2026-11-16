import B4MKit
import SwiftUI

/// "Made from" and "Made into" chips under a detail view. Each chip opens that file; Branch retries this one.
struct LineageChipsView: View {
  let lineage: FileLineage
  let onOpen: (LineageNode) -> Void
  let onBranch: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !lineage.madeFrom.isEmpty {
        row(title: "Made from", links: lineage.madeFrom, identifier: "lineage-made-from")
      }
      if !lineage.madeInto.isEmpty {
        row(title: "Made into", links: lineage.madeInto, identifier: "lineage-made-into")
      }
      if let onBranch {
        Button(action: onBranch) {
          Label("Branch", systemImage: "arrow.triangle.branch")
        }
        .buttonStyle(.bordered)
        .tint(.white)
        .accessibilityIdentifier("lineage-branch-btn")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(.ultraThinMaterial)
    .environment(\.colorScheme, .dark)
  }

  private func row(title: String, links: [LineageLink], identifier: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(links) { link in chip(link) }
        }
      }
    }
    .accessibilityIdentifier(identifier)
  }

  private func chip(_ link: LineageLink) -> some View {
    Button {
      onOpen(link.node)
    } label: {
      HStack(spacing: 6) {
        Image(systemName: symbol(for: link.node))
        Text(label(for: link)).lineLimit(1)
      }
      .font(.footnote)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(.white.opacity(0.14), in: Capsule())
    }
    .buttonStyle(.plain)
    .disabled(link.node.mediaItem == nil)
    .accessibilityIdentifier("lineage-chip-\(link.node.id)")
  }

  private func label(for link: LineageLink) -> String {
    if link.node.isRedacted { return "Private file" }
    let kind = link.node.kind?.chipTitle ?? "File"
    if case .other = link.role { return kind }
    return "\(kind) \u{00B7} \(link.role.title)"
  }

  private func symbol(for node: LineageNode) -> String {
    if node.isRedacted { return "lock" }
    switch node.kind {
    case .image: return "photo"
    case .video: return "film"
    case .audio: return "waveform"
    case nil: return "doc"
    }
  }
}

extension MediaKind {
  fileprivate var chipTitle: String {
    switch self {
    case .image: "Image"
    case .video: "Video"
    case .audio: "Audio"
    }
  }
}
