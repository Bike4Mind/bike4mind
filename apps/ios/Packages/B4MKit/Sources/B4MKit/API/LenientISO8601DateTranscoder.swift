import Foundation
import OpenAPIRuntime

/// The server serializes JS dates with milliseconds (`2026-10-31T12:00:00.123Z`) but some fields arrive
/// without; the runtime's stock transcoders accept only one of the two shapes.
struct LenientISO8601DateTranscoder: DateTranscoder {
  func encode(_ date: Date) throws -> String {
    date.formatted(Self.withFractionalSeconds)
  }

  func decode(_ dateString: String) throws -> Date {
    if let date = try? Self.withFractionalSeconds.parse(dateString) { return date }
    return try Self.plain.parse(dateString)
  }

  private static let withFractionalSeconds = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  private static let plain = Date.ISO8601FormatStyle()
}
