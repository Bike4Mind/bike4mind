import Foundation

enum WireDecoding {
  /// A log-safe account of a decode failure: the failure kind and the key path, never the payload's values.
  static func describe(_ error: any Error) -> String {
    guard let decodingError = error as? DecodingError else { return String(describing: type(of: error)) }
    switch decodingError {
    case .keyNotFound(let key, let context):
      return "keyNotFound(\(key.stringValue)) at \(path(context.codingPath))"
    case .valueNotFound(let type, let context):
      return "valueNotFound(\(type)) at \(path(context.codingPath))"
    case .typeMismatch(let type, let context):
      return "typeMismatch(\(type)) at \(path(context.codingPath))"
    case .dataCorrupted(let context):
      return "dataCorrupted at \(path(context.codingPath))"
    @unknown default:
      return "DecodingError"
    }
  }

  private static func path(_ codingPath: [any CodingKey]) -> String {
    codingPath.isEmpty
      ? "<root>" : codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
  }
}
