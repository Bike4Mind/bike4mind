import Foundation

/// A standing instruction the brief composer follows (e.g. "always lead with anything about invoices").
public struct AssistantInstruction: Decodable, Equatable, Identifiable, Sendable {
  public let id: String
  public let text: String
  public let createdAt: Date

  public init(id: String, text: String, createdAt: Date) {
    self.id = id
    self.text = text
    self.createdAt = createdAt
  }

  /// Must stay in sync with the server caps in `b4m-core/common/src/schemas/assistantInstruction.ts`.
  public static let maxLength = 280
  public static let maxCount = 20

  /// The trimmed text the server would accept, or `nil`. Length is counted in UTF-16 units, as the server's
  /// JavaScript `length` counts it.
  public static func validated(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.utf16.count <= maxLength else { return nil }
    return trimmed
  }
}
