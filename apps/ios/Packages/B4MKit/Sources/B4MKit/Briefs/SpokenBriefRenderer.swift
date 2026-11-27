import Foundation

/// Turns a brief into the ordered sentences voice mode reads aloud: headline, what happened, what was handled,
/// then the first decision still waiting on the user. Everything is plain text, so no markdown reaches speech.
public enum SpokenBriefRenderer {
  /// Items read per section before the rest collapse into "And N more."
  public static let sectionCap = 5

  public static func sections(for brief: Brief) -> [String] {
    switch brief.status {
    case .composing, .unknown: return ["Your brief is still being put together."]
    case .failed: return ["Your brief couldn't be put together."]
    case .ready: break
    }

    var sections: [String] = []
    let headline = sentence(plain(brief.headline ?? ""))
    if !headline.isEmpty { sections.append(headline) }
    if let happened = itemSection("Here's what happened.", brief.happened.map(\.text)) { sections.append(happened) }
    if let handled = itemSection("Handled for you.", brief.handled.map(\.text)) { sections.append(handled) }

    let pending = brief.decisions.filter(isPending)
    if let first = pending.first, let prompt = prompt(for: first) {
      let count = pending.count == 1 ? "One thing needs you." : "\(pending.count) things need you."
      sections.append("\(count) \(prompt)")
    }
    return sections.isEmpty ? ["Nothing new needs you right now."] : sections
  }

  /// True while the user can still answer the decision: a pending approval or an open question.
  public static func isPending(_ decision: BriefDecision) -> Bool {
    decision.approval?.state == .pending || decision.question?.state == .open
  }

  /// What to say to put a decision to the user, or nil once it can no longer be answered.
  public static func prompt(for decision: BriefDecision) -> String? {
    let text = sentence(plain(decision.text))
    if decision.approval?.state == .pending {
      return join(text, "Approve or deny it?")
    }
    guard let question = decision.question, question.state == .open else { return nil }
    let options = question.options.map(plain).filter { !$0.isEmpty }
    let ask = options.isEmpty ? "Say reply and your answer." : "Options: \(list(options))."
    return join(text, ask)
  }

  /// Strips markdown and links down to the words a listener should hear. A link keeps its label; a bare URL
  /// is dropped, since reading one aloud is noise.
  public static func plain(_ markdown: String) -> String {
    var text = markdown
    text = replace(#"!?\[([^\]]*)\]\([^)]*\)"#, in: text, with: "$1")
    text = replace(#"(?:https?://|www\.)[^\s)\]]+"#, in: text, with: "")
    text = replace(#"(?m)^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?)"#, in: text, with: "")
    text = replace(#"(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])"#, in: text, with: " ")
    text = replace(#"[*_`~#]"#, in: text, with: "")
    text = replace(#"\(\s*\)"#, in: text, with: "")
    text = replace(#"\s+"#, in: text, with: " ")
    text = replace(#" ([.,;:!?])"#, in: text, with: "$1")
    return text.trimmingCharacters(in: .whitespaces)
  }

  private static func itemSection(_ lead: String, _ items: [String]) -> String? {
    let spoken = items.map { sentence(plain($0)) }.filter { !$0.isEmpty }
    guard !spoken.isEmpty else { return nil }
    var parts = [lead] + spoken.prefix(sectionCap)
    if spoken.count > sectionCap { parts.append("And \(spoken.count - sectionCap) more.") }
    return parts.joined(separator: " ")
  }

  /// Ends the text with a full stop unless it already ends a sentence, so items don't run together.
  private static func sentence(_ text: String) -> String {
    guard let last = text.last else { return "" }
    return ".!?".contains(last) ? text : text + "."
  }

  private static func join(_ text: String, _ ask: String) -> String {
    text.isEmpty ? ask : "\(text) \(ask)"
  }

  private static func list(_ options: [String]) -> String {
    switch options.count {
    case 1: return options[0]
    case 2: return "\(options[0]) or \(options[1])"
    default: return options.dropLast().joined(separator: ", ") + ", or " + options[options.count - 1]
    }
  }

  private static func replace(_ pattern: String, in text: String, with template: String) -> String {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
    let range = NSRange(text.startIndex..., in: text)
    return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
  }
}
