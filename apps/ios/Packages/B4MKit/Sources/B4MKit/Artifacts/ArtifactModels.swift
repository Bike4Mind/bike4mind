import Foundation

/// How an artifact's content is shown on a phone.
public enum ArtifactRendering: Equatable, Sendable {
  /// Rendered in the hardened web view (html and svg documents).
  case web
  /// Rendered in the web view through the bundled Mermaid library.
  case mermaid
  /// Selectable monospaced text (code, python, files).
  case code
  /// Formatted prose (blog drafts).
  case markdown
  /// Needs the web app's runtime (react, charts, lattice, chess): offered as "Open full version".
  case fullVersion
  /// A type this build does not know how to draw.
  case unsupported
}

/// The artifact types the API reports. An unknown type decodes as `.other` so a new server-side type never
/// breaks the list.
public enum ArtifactKind: Hashable, Sendable {
  case html, svg, code, python, blogDraft, file, mermaid, react, recharts, lattice, chess
  case other(String)

  public init(wire: String) {
    switch wire {
    case "html": self = .html
    case "svg": self = .svg
    case "code": self = .code
    case "python": self = .python
    case "blog-draft": self = .blogDraft
    case "file": self = .file
    case "mermaid": self = .mermaid
    case "react": self = .react
    case "recharts": self = .recharts
    case "lattice": self = .lattice
    case "chess": self = .chess
    default: self = .other(wire)
    }
  }

  public var rendering: ArtifactRendering {
    switch self {
    case .html, .svg: .web
    case .mermaid: .mermaid
    case .code, .python, .file: .code
    case .blogDraft: .markdown
    case .react, .recharts, .lattice, .chess: .fullVersion
    case .other: .unsupported
    }
  }

  public var displayName: String {
    switch self {
    case .html: "HTML"
    case .svg: "SVG"
    case .code: "Code"
    case .python: "Python"
    case .blogDraft: "Blog draft"
    case .file: "File"
    case .mermaid: "Diagram"
    case .react: "React"
    case .recharts: "Chart"
    case .lattice: "Lattice"
    case .chess: "Chess"
    case .other(let wire): wire.isEmpty ? "Artifact" : wire.capitalized
    }
  }

  /// SF Symbol for the row and the detail header.
  public var symbolName: String {
    switch self {
    case .html: "globe"
    case .svg: "scribble.variable"
    case .code: "chevron.left.forwardslash.chevron.right"
    case .python: "terminal"
    case .blogDraft: "doc.text"
    case .file: "doc"
    case .mermaid: "point.3.connected.trianglepath.dotted"
    case .react: "atom"
    case .recharts: "chart.bar.xaxis"
    case .lattice: "square.grid.3x3"
    case .chess: "checkerboard.rectangle"
    case .other: "shippingbox"
    }
  }
}

/// An artifact as the list shows it (no content).
public struct ArtifactSummary: Identifiable, Hashable, Sendable {
  public let id: String
  public let kind: ArtifactKind
  public let title: String
  public let summary: String?
  public let version: Int
  public let sessionID: String?
  public let updatedAt: Date

  public init(
    id: String, kind: ArtifactKind, title: String, summary: String? = nil, version: Int = 1,
    sessionID: String? = nil, updatedAt: Date
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.summary = summary
    self.version = version
    self.sessionID = sessionID
    self.updatedAt = updatedAt
  }

  /// The title, or a type-based stand-in for an untitled artifact.
  public var displayTitle: String {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Untitled \(kind.displayName)" : trimmed
  }
}

/// One artifact with its current content.
public struct Artifact: Identifiable, Hashable, Sendable {
  public let summary: ArtifactSummary
  /// `nil` when the server withheld the content (the caller may not read it).
  public let content: String?

  public init(summary: ArtifactSummary, content: String?) {
    self.summary = summary
    self.content = content
  }

  public var id: String { summary.id }
}

extension ArtifactSummary {
  /// The artifact in the web app, the "Open full version" target until the API exposes a published page URL.
  public var webURL: URL? {
    var components = URLComponents()
    components.scheme = "https"
    components.host = DeepLinkRouter.appHost
    components.path = "/artifacts/\(id)"
    return components.url
  }
}
