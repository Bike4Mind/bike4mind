import Foundation

public enum MarkdownText {
  /// Inline Markdown (emphasis, code spans, links) with line breaks kept. SwiftUI's `Text` does not lay out
  /// block constructs (lists, headings, fenced code), so those show as their source text instead of
  /// being parsed into styling `Text` would drop. Malformed Markdown falls back to the raw string.
  public static func attributed(_ source: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible
    )
    return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
  }
}

/// Where a tapped link in a transcript may go. Model output is steerable by whatever content the model read,
/// and link text hides the target, so only web pages open (in the in-app browser); `tel:`, `sms:`,
/// `facetime:`, `shortcuts:` and every other app scheme are dropped rather than handed to the system.
public enum TranscriptLinkPolicy {
  /// The page to show in the in-app browser, or nil when the link must not open at all.
  public static func webPage(for url: URL) -> URL? {
    guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host() != nil else {
      return nil
    }
    return url
  }
}

/// A reply split into prose and fenced code, so code renders as a framed block (as the web reply
/// does) while prose keeps the inline Markdown of `MarkdownText`.
public enum MarkdownBlock: Equatable, Sendable {
  case prose(String)
  case code(language: String?, code: String)

  /// Splits on ``` and ~~~ fences. A fence still open at the end (a reply mid-stream) runs to the end
  /// of the text, so streaming code shows as code before its closing fence arrives.
  public static func split(_ source: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var prose: [Substring] = []
    var code: [Substring] = []
    var openFence: (marker: String, language: String?)?

    func flushProse() {
      let text = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
      if !text.isEmpty { blocks.append(.prose(text)) }
      prose.removeAll()
    }

    for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if let fence = openFence {
        if closes(fence.marker, trimmed) {
          blocks.append(.code(language: fence.language, code: code.joined(separator: "\n")))
          code.removeAll()
          openFence = nil
        } else {
          code.append(line)
        }
        continue
      }
      if let marker = fenceMarker(trimmed) {
        flushProse()
        let info = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
        let language = info.split(separator: " ").first.map(String.init)
        openFence = (marker, language?.isEmpty == false ? language : nil)
      } else {
        prose.append(line)
      }
    }
    if let fence = openFence {
      blocks.append(.code(language: fence.language, code: code.joined(separator: "\n")))
    }
    flushProse()
    return blocks
  }

  /// A closing fence is a run of the opening character at least as long as the opening run.
  private static func closes(_ marker: String, _ line: String) -> Bool {
    guard let character = marker.first else { return false }
    return line.count >= marker.count && line.allSatisfy { $0 == character }
  }

  private static func fenceMarker(_ line: String) -> String? {
    for character in ["`", "~"] {
      let run = line.prefix { String($0) == character }
      if run.count >= 3 { return String(run) }
    }
    return nil
  }
}
