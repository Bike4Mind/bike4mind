import Foundation

/// The text a reader sees of a quest's reply slots: the last top-level ```choices block and all `<think>`
/// reasoning removed per slot. Must stay in sync with `questReplyText` in
/// b4m-core/common/src/utils/replyChoices.ts and `visibleReplyText` in streamVisibility.ts, which produce the
/// settled reply this app swaps in when a turn finishes; streaming the raw slots would show a choices
/// block that then vanishes on settle.
public enum ReplyVisibility {
  private static let thinkOpen = "<think>"
  private static let thinkClose = "</think>"
  private static let choicesLanguage = "choices"

  /// The joined visible slots, else a non-empty scalar `reply`, else `nil`.
  public static func text(replies: [String], reply: String?) -> String? {
    let joined = replies.map(visibleSlot).filter { !$0.isEmpty }.joined()
    if !joined.isEmpty { return joined }
    guard let reply, !reply.isEmpty else { return nil }
    return reply
  }

  /// One slot with its choices block stripped and its reasoning hidden; empty when nothing visible is left.
  public static func visibleSlot(_ slot: String) -> String {
    hidingThinking(strippingChoices(slot))
  }

  /// Only the answer after the slot's last top-level `</think>` is searched, so a block drafted while
  /// reasoning is never stripped (it is hidden with the reasoning instead).
  static func strippingChoices(_ slot: String) -> String {
    guard let start = answerStart(slot) else { return slot }
    let answer = slot[start...]
    guard let fence = lastChoicesFence(in: answer) else { return slot }

    let before = trimmingTrailingWhitespace(answer[..<fence.start])
    let after = fence.end.map { droppingLeadingBlankLines(answer[$0...]) } ?? ""
    let kept: String
    if after.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      kept = before
    } else {
      kept = before.isEmpty ? after : before + "\n\n" + after
    }
    return String(slot[..<start]) + kept
  }

  /// Text outside `<think>` blocks (depth-tracked); a stray `</think>` is text. Empty when only whitespace is left.
  static func hidingThinking(_ slot: String) -> String {
    var depth = 0
    var visible = ""
    for token in thinkTokens(slot) {
      switch token {
      case .open: depth += 1
      case .close(let text):
        if depth > 0 { depth -= 1 } else { visible += text }
      case .text(let text):
        if depth == 0 { visible += text }
      }
    }
    return visible.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : visible
  }

  /// Where the visible answer starts: past the last top-level `</think>`, the start when there is none, or
  /// `nil` while a `<think>` is still open.
  private static func answerStart(_ slot: String) -> String.Index? {
    var depth = 0
    var start = slot.startIndex
    var cursor = slot.startIndex
    while let marker = nextThinkMarker(in: slot, from: cursor) {
      if marker.isOpen {
        depth += 1
      } else if depth > 0 {
        depth -= 1
        if depth == 0 { start = marker.range.upperBound }
      }
      cursor = marker.range.upperBound
    }
    return depth == 0 ? start : nil
  }

  private enum ThinkToken {
    case open
    case close(String)
    case text(String)
  }

  private static func thinkTokens(_ slot: String) -> [ThinkToken] {
    var tokens: [ThinkToken] = []
    var cursor = slot.startIndex
    while let marker = nextThinkMarker(in: slot, from: cursor) {
      if cursor < marker.range.lowerBound { tokens.append(.text(String(slot[cursor..<marker.range.lowerBound]))) }
      tokens.append(marker.isOpen ? .open : .close(thinkClose))
      cursor = marker.range.upperBound
    }
    if cursor < slot.endIndex { tokens.append(.text(String(slot[cursor...]))) }
    return tokens
  }

  private static func nextThinkMarker(
    in slot: String, from cursor: String.Index
  ) -> (range: Range<String.Index>, isOpen: Bool)? {
    let open = slot.range(of: thinkOpen, range: cursor..<slot.endIndex)
    let close = slot.range(of: thinkClose, range: cursor..<slot.endIndex)
    switch (open, close) {
    case (let open?, let close?): return open.lowerBound < close.lowerBound ? (open, true) : (close, false)
    case (let open?, nil): return (open, true)
    case (nil, let close?): return (close, false)
    case (nil, nil): return nil
    }
  }

  private struct FenceSpan {
    let start: String.Index
    /// End of the closing fence line; `nil` for a block still open at the end (streaming or truncated).
    let end: String.Index?
  }

  private struct OpenFence {
    let start: String.Index
    let character: Character
    let length: Int
    let isChoices: Bool
  }

  /// The last top-level ```choices fence, walking fences line by line (CommonMark: a fence closes on a bare
  /// line of the same character at least as long), so a sample nested in a longer fence is content.
  private static func lastChoicesFence(in text: Substring) -> FenceSpan? {
    var last: FenceSpan?
    var open: OpenFence?
    // "\r\n" is one Character in Swift, so it is matched as a newline of its own.
    for line in text.split(omittingEmptySubsequences: false, whereSeparator: isLineBreak) {
      guard let fence = fenceRun(line) else { continue }
      if let current = open {
        let isClose =
          fence.character == current.character && fence.length >= current.length
          && fence.info.allSatisfy { $0 == " " || $0 == "\t" }
        guard isClose else { continue }
        if current.isChoices { last = FenceSpan(start: current.start, end: line.endIndex) }
        open = nil
      } else {
        // A backtick fence's info string cannot contain a backtick (that line is inline code).
        if fence.character == "`" && fence.info.contains("`") { continue }
        let isChoices =
          fence.character == "`" && fence.length == 3
          && fence.info.trimmingCharacters(in: .whitespaces).lowercased() == choicesLanguage
        open = OpenFence(
          start: line.startIndex, character: fence.character, length: fence.length, isChoices: isChoices)
      }
    }
    if let open, open.isChoices { last = FenceSpan(start: open.start, end: nil) }
    return last
  }

  /// A line's fence run (3+ backticks or tildes after optional spaces and tabs) and the rest of the line.
  private static func fenceRun(_ line: Substring) -> (character: Character, length: Int, info: Substring)? {
    let body = line.drop { $0 == " " || $0 == "\t" }
    guard let character = body.first, character == "`" || character == "~" else { return nil }
    let run = body.prefix { $0 == character }
    guard run.count >= 3 else { return nil }
    return (character, run.count, body.dropFirst(run.count))
  }

  private static func isLineBreak(_ character: Character) -> Bool {
    character == "\n" || character == "\r\n"
  }

  private static func trimmingTrailingWhitespace(_ text: Substring) -> String {
    var trimmed = text
    while let last = trimmed.last, last.isWhitespace { trimmed = trimmed.dropLast() }
    return String(trimmed)
  }

  /// Drops whole lines of spaces and tabs (with their newlines) from the start.
  private static func droppingLeadingBlankLines(_ text: Substring) -> String {
    var rest = text
    while let newline = rest.firstIndex(where: isLineBreak),
      rest[..<newline].allSatisfy({ $0 == " " || $0 == "\t" })
    {
      rest = rest[rest.index(after: newline)...]
    }
    return String(rest)
  }
}
