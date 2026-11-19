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
    let chunks = spoken.map { $0.split(whereSeparator: \.isWhitespace).map { normalize($0) }.filter { !$0.isEmpty } }
    let said = chunks.flatMap { $0 }
    guard heard.contains(where: { !$0.isEmpty }), !said.isEmpty else { return recognized }
    // Echo the user talks over is what was playing when they began, so it must reach the chunk now playing.
    let recentFrom = max(0, said.count - (chunks.last(where: { !$0.isEmpty })?.count ?? 0) - gapTolerance)

    // A stray or misheard word can come before the echo, so it may begin at any of the first few heard words,
    // and the task may have started anywhere in the reply, so try every place that word was spoken.
    var echoEnd = 0
    for first in heard.indices.filter({ !heard[$0].isEmpty }).prefix(max(1, gapTolerance)) {
      for start in said.indices where said[start] == heard[first] {
        echoEnd = max(
          echoEnd,
          echoLength(
            heard: heard, said: said, start: start, first: first, tolerance: gapTolerance, recentFrom: recentFrom))
      }
    }
    return words[echoEnd...].joined(separator: " ")
  }

  /// How many heard words, from the start, are echo when `heard[first]` lines up with `said[start]`.
  private static func echoLength(
    heard: [String], said: [String], start: Int, first: Int, tolerance: Int, recentFrom: Int
  ) -> Int {
    var next = start
    var end = 0
    var matched = 0
    var gap = 0
    let order = heard.indices[first...].filter { !heard[$0].isEmpty }
    var position = 0
    while position < order.count {
      let index = order[position]
      let word = heard[index]
      position += 1
      if gap > 0 {
        // After a misheard word the echo picks up again only where the next two heard words sit side by side in the
        // reply, or on the reply's last word; one loose match would eat the user's own words ("what is the capital").
        // A run as long as the tolerance stands for about as many spoken words, so it resumes just past that run.
        guard gap < lookahead else { break }
        let candidates = gap >= tolerance ? next + gap - 1...next + gap : next...next + lookahead - 1
        if position < order.count {
          let following = heard[order[position]]
          let resume = candidates.first {
            $0 + 1 < said.count && said[$0] == word && said[$0 + 1] == following
          }
          if let resume {
            next = resume + 2
            end = order[position] + 1
            matched += 2
            gap = 0
            position += 1
            continue
          }
        } else if next < said.count, (next...next + lookahead - 1).contains(said.count - 1), said.last == word {
          next = said.count
          end = index + 1
          matched += 1
          gap = 0
          continue
        }
        gap += 1
        continue
      }
      // After a stray word the first two echoed words must be adjacent, or scattered reply words in the
      // user's own question ("what is the capital of ...") would line up as echo.
      let reach = matched == 0 || (first > 0 && matched < 2) ? 1 : lookahead
      let window = said[min(next, said.count)..<min(next + reach, said.count)]
      if let hit = window.firstIndex(of: word) {
        next = hit + 1
        end = index + 1
        matched += 1
        gap = 0
      } else {
        gap += 1
      }
    }
    // One matching word is more likely the user ("the weather today", "wait Paris"), unless it opens the transcript
    // and is the last word played so far, which is all of the echo a recognizer that started late can catch.
    if matched < 2, first > 0 || (end < heard.count && next < said.count) { return 0 }
    if end < heard.count, next < recentFrom { return 0 }
    return end
  }

  private static func normalize(_ word: Substring) -> String {
    String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
  }
}
