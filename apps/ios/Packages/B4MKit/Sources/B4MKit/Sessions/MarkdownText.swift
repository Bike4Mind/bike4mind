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
