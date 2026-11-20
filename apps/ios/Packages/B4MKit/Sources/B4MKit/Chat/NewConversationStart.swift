import Foundation

/// The time-of-day greeting at the top of the new-conversation screen.
public enum StartGreeting {
  /// "Good morning," / "Good afternoon," / "Good evening," by the local hour; the small hours count as evening.
  public static func salutation(at date: Date, calendar: Calendar = .current) -> String {
    switch calendar.component(.hour, from: date) {
    case 5..<12: "Good morning"
    case 12..<18: "Good afternoon"
    default: "Good evening"
    }
  }

  /// The headline: the salutation, plus the first name when one is known.
  public static func headline(at date: Date, firstName: String?, calendar: Calendar = .current) -> String {
    let salutation = salutation(at: date, calendar: calendar)
    guard let name = firstName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
      return salutation
    }
    return "\(salutation), \(name)"
  }

  public static let subline = "What are we working on?"
}

/// A starter chip: tapping it only prefills the draft (or opens dictation); it never sends.
public enum StarterChip: String, CaseIterable, Sendable, Identifiable {
  case write, brainstorm, explainCode, voiceNote

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .write: "Help me write"
    case .brainstorm: "Brainstorm ideas"
    case .explainCode: "Explain some code"
    case .voiceNote: "Voice note"
    }
  }

  public var symbol: String {
    switch self {
    case .write: "pencil.line"
    case .brainstorm: "lightbulb"
    case .explainCode: "chevron.left.forwardslash.chevron.right"
    case .voiceNote: "mic"
    }
  }

  /// The text the draft starts with; `nil` for the chip that opens dictation instead.
  public var prefill: String? {
    switch self {
    case .write: "Help me write "
    case .brainstorm: "Brainstorm ideas for "
    case .explainCode: "Explain this code: "
    case .voiceNote: nil
    }
  }
}
