import B4MKit
import SwiftUI

/// One artifact, rendered by type (see `ArtifactRendering`).
struct ArtifactDetailView: View {
  @State private var model: ArtifactDetailViewModel
  @Environment(\.colorScheme) private var colorScheme
  @State private var safariURL: URL?

  init(summary: ArtifactSummary, api: any ArtifactsAPI) {
    _model = State(initialValue: ArtifactDetailViewModel(summary: summary, api: api))
  }

  var body: some View {
    content
      .background(Tokens.Palette.background)
      .navigationTitle(model.summary.displayTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if let url = model.summary.webURL {
          ToolbarItem(placement: .primaryAction) {
            Button {
              safariURL = url
            } label: {
              Label("Open in web app", systemImage: "safari")
            }
            .accessibilityIdentifier("artifact-open-web-btn")
          }
        }
      }
      .task { await model.load() }
      .inAppSafari(url: $safariURL)
  }

  @ViewBuilder
  private var content: some View {
    switch model.phase {
    case .loading:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("artifact-loading")
    case .failed(let error):
      ContentUnavailableView {
        Label("Couldn't open this artifact", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        Button("Try Again") { Task { await model.load() } }
          .buttonStyle(.borderedProminent)
      }
    case .loaded(let artifact):
      loaded(artifact)
    }
  }

  @ViewBuilder
  private func loaded(_ artifact: Artifact) -> some View {
    let summary = artifact.summary
    switch summary.kind.rendering {
    case .fullVersion:
      fullVersionFallback(summary)
    case .unsupported:
      ContentUnavailableView(
        "Can't show this artifact", systemImage: "shippingbox",
        description: Text("This app doesn't support \(summary.kind.displayName) artifacts yet."))
    default:
      if let content = artifact.content, !content.isEmpty {
        rendered(summary: summary, content: content)
      } else {
        ContentUnavailableView(
          "Nothing to show", systemImage: "doc", description: Text("This artifact has no content you can read."))
      }
    }
  }

  @ViewBuilder
  private func rendered(summary: ArtifactSummary, content: String) -> some View {
    switch summary.kind.rendering {
    case .web where summary.kind == .svg:
      webView(ArtifactWebDocument.html(fromSVG: content))
    case .web:
      webView(ArtifactWebDocument.html(from: content))
    case .mermaid:
      if let library = ArtifactMermaidLibrary.source {
        webView(
          ArtifactWebDocument.html(fromMermaid: content, mermaidLibrary: library, darkMode: colorScheme == .dark))
      } else {
        textBody(content)
      }
    case .markdown:
      ScrollView {
        VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
          ForEach(Array(MarkdownBlock.split(content).enumerated()), id: \.offset) { _, block in
            MarkdownBlockView(block: block)
          }
        }
        .padding(Tokens.Spacing.m)
      }
      .accessibilityIdentifier("artifact-markdown")
    default:
      textBody(content)
    }
  }

  private func webView(_ html: String) -> some View {
    ArtifactWebView(html: html) { safariURL = $0 }
      .accessibilityIdentifier("artifact-web")
  }

  private func textBody(_ content: String) -> some View {
    ScrollView([.vertical, .horizontal]) {
      Text(content)
        .font(.system(.footnote, design: .monospaced))
        .foregroundStyle(Tokens.Palette.primaryText)
        .textSelection(.enabled)
        .padding(Tokens.Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityIdentifier("artifact-text")
  }

  private func fullVersionFallback(_ summary: ArtifactSummary) -> some View {
    ContentUnavailableView {
      Label(summary.displayTitle, systemImage: summary.kind.symbolName)
    } description: {
      Text(
        "\(summary.kind.displayName) artifacts run in the web app. Open the full version to use it as it was made."
      )
    } actions: {
      if let url = summary.webURL {
        Button("Open full version") { safariURL = url }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("artifact-open-full-btn")
      }
    }
  }
}

/// The bundled Mermaid library, read once. Rendering is client-side only (on the web too), so it ships with the app.
private enum ArtifactMermaidLibrary {
  static let source: String? = {
    let url =
      Bundle.main.url(forResource: "mermaid.min", withExtension: "js")
      ?? Bundle.main.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "Artifacts")
    return url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
  }()
}
