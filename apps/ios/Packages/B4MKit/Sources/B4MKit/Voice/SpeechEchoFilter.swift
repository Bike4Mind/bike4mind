import Foundation

/// Separates the user's words from the speaker's own reply picked up by the mic.
///
/// The recognizer keeps running while the reply plays, so its transcript can open with the reply itself,
/// misheard here and there, and starting wherever in the reply the recognition task began.
struct SpeechEchoFilter {
  /// How far ahead in the spoken text the next heard word may land, so dropped words do not break the echo.
  static let lookahead = 8

  /// The part of `recognized` left after its leading echo of `spoken`, in the recognizer's own casing.
  /// Runs of fewer than `gapTolerance` unmatched words inside the echo count as misheard echo.
  static func residual(recognized: String, spoken: [String], gapTolerance: Int) -> String {
    let words = recognized.split(whereSeparator: \.isWhitespace)
    let heard = words.map { normalize($0) }
    let said = spoken.flatMap { $0.split(whereSeparator: \.isWhitespace).map { normalize($0) } }.filter { !$0.isEmpty }
    guard let first = heard.first(where: { !$0.isEmpty }), !said.isEmpty else { return recognized }

    // The task may have started anywhere in the reply, so try every place the first heard word was spoken.
    var echoEnd = 0
    for start in said.indices where said[start] == first {
      echoEnd = max(echoEnd, echoLength(heard: heard, said: said, from: start, gapTolerance: gapTolerance))
    }
    return words[echoEnd...].joined(separator: " ")
  }

  /// How many heard words, from the start, are echo when the first one lines up with `said[start]`.
  private static func echoLength(heard: [String], said: [String], from start: Int, gapTolerance: Int) -> Int {
    var next = start
    var end = 0
    var matched = 0
    var gap = 0
    for (index, word) in heard.enumerated() where !word.isEmpty {
      let window = said[min(next, said.count)..<min(next + (matched == 0 ? 1 : lookahead), said.count)]
      if let hit = window.firstIndex(of: word) {
        next = hit + 1
        end = index + 1
        matched += 1
        gap = 0
      } else {
        gap += 1
        if gap >= gapTolerance { break }
      }
    }
    // One matching word followed by unmatched ones is more likely the user than the reply ("the weather today").
    if matched < 2, end < heard.count { return 0 }
    return end
  }

  private static func normalize(_ word: Substring) -> String {
    String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
  }
}
