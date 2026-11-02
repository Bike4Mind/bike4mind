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
