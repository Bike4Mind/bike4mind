import Foundation

/// Turns a streaming reply into sentences worth speaking, so playback starts before the turn completes.
///
/// A frame's `reply` is the CUMULATIVE text, so the chunker remembers how much it has already handed out
/// and returns only newly completed sentences. A sentence is complete once its terminator is followed by
/// whitespace (the terminator alone could still be the start of "3.14" or "e.g."). The remainder is
/// released by the final update. Platform-neutral on purpose: the Android client chunks the same way.
public struct ReplySpeechChunker: Sendable {
  /// Sentences shorter than this are merged into the next one, so "Yes." is not a lone utterance.
  public static let minimumChunkLength = 24

  private var consumed = ""

  public init() {}

  /// Newly speakable chunks, cleaned for speech. `isFinal` flushes whatever is left.
  public mutating func ingest(cumulative: String, isFinal: Bool) -> [String] {
    // A reply that no longer starts with what was already handed out was rewritten (a filtered block
    // vanished); speaking from an unknown offset would repeat or skip text, so wait for a stable update.
    // The final update is that one: resume from the longest prefix the two still share.
    if !cumulative.hasPrefix(consumed) {
      guard isFinal else { return [] }
      consumed = String(zip(consumed, cumulative).prefix { $0 == $1 }.map(\.0))
    }
    let rest = cumulative.dropFirst(consumed.count)

    var chunks: [String] = []
    var chunkStart = rest.startIndex
    var index = rest.startIndex
    while index < rest.endIndex {
      let character = rest[index]
      let next = rest.index(after: index)
      let isBoundary =
        (".!?".contains(character) && next < rest.endIndex && rest[next].isWhitespace)
        || character == "\n"
      if isBoundary {
        let raw = rest[chunkStart..<next]
        let insideCodeFence = raw.components(separatedBy: "```").count % 2 == 0
        let cleaned = SpeechText.clean(String(raw))
        if !insideCodeFence, cleaned.count >= Self.minimumChunkLength {
          chunks.append(cleaned)
          chunkStart = next
        }
      }
      index = next
    }
    consumed += rest[rest.startIndex..<chunkStart]

    if isFinal {
      let tail = SpeechText.clean(String(rest[chunkStart...]))
      if !tail.isEmpty { chunks.append(tail) }
      consumed = cumulative
    }
    return chunks
  }
}

/// Strips markdown so a reply reads naturally aloud.
public enum SpeechText {
  private static let rules: [(NSRegularExpression, String)] = [
    ("```[\\s\\S]*?```", " Code on screen. "),
    ("!\\[[^\\]]*\\]\\([^)]*\\)", ""),
    ("\\[([^\\]]+)\\]\\([^)]*\\)", "$1"),
    ("https?://\\S+", "link"),
    ("`([^`]*)`", "$1"),
    ("(?m)^\\s{0,3}#{1,6}\\s+", ""),
    ("(?m)^\\s*[-*+]\\s+", ""),
    ("(?m)^\\s*\\d+\\.\\s+", ""),
    ("[*_]{1,3}", ""),
    ("\\|", " "),
  ].compactMap { pattern, template in
    (try? NSRegularExpression(pattern: pattern)).map { ($0, template) }
  }

  public static func clean(_ markdown: String) -> String {
    var text = markdown
    for (expression, template) in rules {
      text = expression.stringByReplacingMatches(
        in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
    return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }
}
