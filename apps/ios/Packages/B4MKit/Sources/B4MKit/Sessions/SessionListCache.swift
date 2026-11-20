import Foundation
import os

/// Persists the first page of the session list so the screen renders instantly on the next open,
/// before the network answers. Online-first: the cache only ever seeds the UI, the server wins.
public protocol SessionListCache: Sendable {
  func load() async -> [SessionSummary]?
  func save(_ sessions: [SessionSummary]) async
  /// Called on sign-out: cached rows belong to the account that fetched them.
  func clear() async
}

/// JSON file in the Caches directory (the OS may evict it, which is fine for a cache). One file per
/// server, so switching the debug server never shows another deployment's rows.
public actor FileSessionListCache: SessionListCache {
  private let fileURL: URL
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "cache")

  public init(directory: URL, environment: ServerEnvironment) {
    let host = environment.baseURL.host() ?? "default"
    fileURL = directory.appending(path: "sessions-\(host).json", directoryHint: .notDirectory)
  }

  public static func defaultDirectory() -> URL {
    URL.cachesDirectory.appending(path: "Bike4Mind-API", directoryHint: .isDirectory)
  }

  public func load() -> [SessionSummary]? {
    guard let data = try? Data(contentsOf: fileURL) else { return nil }
    do {
      return try Self.decoder.decode([SessionSummary].self, from: data)
    } catch {
      // A schema change leaves an unreadable file; drop it rather than fail every launch.
      logger.notice("Discarding unreadable session cache: \(error, privacy: .public)")
      try? FileManager.default.removeItem(at: fileURL)
      return nil
    }
  }

  public func save(_ sessions: [SessionSummary]) {
    do {
      try FileManager.default.createDirectory(
        at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Self.encoder.encode(sessions).write(to: fileURL, options: .atomic)
    } catch {
      logger.error("Writing session cache failed: \(error, privacy: .public)")
    }
  }

  public func clear() {
    try? FileManager.default.removeItem(at: fileURL)
  }

  private static var encoder: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }

  private static var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}

/// For previews and tests.
public actor InMemorySessionListCache: SessionListCache {
  private var sessions: [SessionSummary]?

  public init(_ sessions: [SessionSummary]? = nil) {
    self.sessions = sessions
  }

  public func load() -> [SessionSummary]? { sessions }
  public func save(_ sessions: [SessionSummary]) { self.sessions = sessions }
  public func clear() { sessions = nil }
}
