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

/// A reply split into the block constructs SwiftUI's `Text` cannot lay out (headings, list items, quotes,
/// rules, fenced code), so each renders as its own view as the web reply does, while prose keeps the inline
/// Markdown of `MarkdownText`. Every case's text is still inline Markdown.
public enum MarkdownBlock: Equatable, Sendable {
  case prose(String)
  case heading(level: Int, text: String)
  case listItem(marker: ListMarker, depth: Int, text: String)
  case quote(String)
  case rule
  case code(language: String?, code: String)

  public enum ListMarker: Equatable, Sendable {
    case bullet
    /// The source's own number and delimiter, e.g. "3." or "3)".
    case number(String)
  }

  /// Splits on ``` and ~~~ fences and on block lines. A fence still open at the end (a reply mid-stream)
  /// runs to the end of the text, so streaming code shows as code before its closing fence arrives.
  public static func split(_ source: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var prose: [Substring] = []
    var quote: [String] = []
    var code: [Substring] = []
    var openFence: (marker: String, language: String?)?

    func flushProse() {
      let text = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
      if !text.isEmpty { blocks.append(.prose(text)) }
      prose.removeAll()
    }

    func flushQuote() {
      if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))) }
      quote.removeAll()
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
        flushQuote()
        let info = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
        let language = info.split(separator: " ").first.map(String.init)
        openFence = (marker, language?.isEmpty == false ? language : nil)
      } else if let quoted = quoteText(trimmed) {
        flushProse()
        quote.append(quoted)
      } else if let block = blockLine(line, trimmed: trimmed) {
        flushProse()
        flushQuote()
        blocks.append(block)
      } else {
        flushQuote()
        prose.append(line)
      }
    }
    if let fence = openFence {
      blocks.append(.code(language: fence.language, code: code.joined(separator: "\n")))
    }
    flushProse()
    flushQuote()
    return blocks
  }

  private static func blockLine(_ line: Substring, trimmed: String) -> MarkdownBlock? {
    if let heading = heading(trimmed) { return heading }
    if isRule(trimmed) { return .rule }
    return listItem(line)
  }

  /// ATX heading: 1-6 `#` then a space and text. A closing run of `#` is dropped.
  private static func heading(_ line: String) -> MarkdownBlock? {
    let level = line.prefix { $0 == "#" }.count
    guard (1...6).contains(level) else { return nil }
    let rest = line.dropFirst(level)
    guard rest.first == " " else { return nil }
    var text = rest.trimmingCharacters(in: .whitespaces)
    let closing = text.reversed().prefix { $0 == "#" }.count
    if closing > 0, closing == text.count || text.dropLast(closing).last == " " {
      text = text.dropLast(closing).trimmingCharacters(in: .whitespaces)
    }
    return text.isEmpty ? nil : .heading(level: level, text: text)
  }

  /// Three or more `-`, `*` or `_` alone on a line (spaces between allowed).
  private static func isRule(_ line: String) -> Bool {
    let marks = line.filter { $0 != " " }
    guard marks.count >= 3, let first = marks.first, "-*_".contains(first) else { return false }
    return marks.allSatisfy { $0 == first }
  }

  /// `- `, `* `, `+ ` or `1. ` / `1) `; every two leading spaces nest one level deeper.
  private static func listItem(_ line: Substring) -> MarkdownBlock? {
    let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    let body = line.drop { $0 == " " || $0 == "\t" }
    let depth = indent / 2
    if let bullet = body.first, "-*+".contains(bullet), body.dropFirst().first == " " {
      let text = body.dropFirst(2).trimmingCharacters(in: .whitespaces)
      return text.isEmpty ? nil : .listItem(marker: .bullet, depth: depth, text: text)
    }
    let digits = body.prefix { $0.isASCII && $0.isNumber }
    guard (1...9).contains(digits.count) else { return nil }
    let afterDigits = body.dropFirst(digits.count)
    guard let delimiter = afterDigits.first, delimiter == "." || delimiter == ")",
      afterDigits.dropFirst().first == " "
    else { return nil }
    let text = afterDigits.dropFirst(2).trimmingCharacters(in: .whitespaces)
    return text.isEmpty ? nil : .listItem(marker: .number(digits + String(delimiter)), depth: depth, text: text)
  }

  private static func quoteText(_ line: String) -> String? {
    guard line.first == ">" else { return nil }
    let rest = line.dropFirst()
    return String(rest.first == " " ? rest.dropFirst() : rest)
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
