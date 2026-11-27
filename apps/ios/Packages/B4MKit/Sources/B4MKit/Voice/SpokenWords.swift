import Foundation

/// Words the way speech is compared: lowercased, apostrophes dropped, punctuation read as a break.
enum SpokenWords {
  static func normalized(_ text: String) -> [String] {
    let kept = text.lowercased().unicodeScalars
      .filter { $0 != "'" && $0 != "\u{2019}" }
      .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
    return String(kept).split(separator: " ").map(String.init)
  }

  /// Whether `words` appear back to back, in order, somewhere in `spoken`.
  static func isRun(_ words: [String], in spoken: [String]) -> Bool {
    guard !words.isEmpty, words.count <= spoken.count else { return false }
    return (0...(spoken.count - words.count)).contains { spoken[$0..<($0 + words.count)].elementsEqual(words) }
  }
}
