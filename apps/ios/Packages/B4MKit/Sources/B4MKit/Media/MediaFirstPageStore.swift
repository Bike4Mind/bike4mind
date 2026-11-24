import Foundation
import os

/// Persists page 1 of the media list per kind filter so the gallery renders instantly on the next open,
/// before the network answers. Online-first: the cache only ever seeds the UI, the server wins.
public protocol MediaListCache: Sendable {
  func load(kind: MediaKind?) async -> MediaPage?
  func save(_ page: MediaPage, kind: MediaKind?) async
  /// Called on sign-out: cached rows belong to the account that fetched them.
  func clear() async
}

/// JSON files in the Caches directory, one per server and kind filter, so switching the debug server never
/// shows another deployment's tiles.
public actor FileMediaListCache: MediaListCache {
  private let directory: URL
  private let host: String
  private let logger = Logger(subsystem: "com.bike4mind.app", category: "cache")

  public init(directory: URL, environment: ServerEnvironment) {
    self.directory = directory
    host = environment.baseURL.host() ?? "default"
  }

  public func load(kind: MediaKind?) -> MediaPage? {
    let url = fileURL(kind: kind)
    guard let data = try? Data(contentsOf: url) else { return nil }
    do {
      return try Self.decoder.decode(MediaPage.self, from: data)
    } catch {
      // A schema change leaves an unreadable file; drop it rather than fail every launch.
      logger.notice("Discarding unreadable media cache: \(error, privacy: .public)")
      try? FileManager.default.removeItem(at: url)
      return nil
    }
  }

  public func save(_ page: MediaPage, kind: MediaKind?) {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try Self.encoder.encode(page).write(to: fileURL(kind: kind), options: .atomic)
    } catch {
      logger.error("Writing media cache failed: \(error, privacy: .public)")
    }
  }

  public func clear() {
    for kind in [nil] + MediaKind.allCases.map(Optional.some) {
      try? FileManager.default.removeItem(at: fileURL(kind: kind))
    }
  }

  private func fileURL(kind: MediaKind?) -> URL {
    directory.appending(path: "media-\(host)-\(kind?.rawValue ?? "all").json", directoryHint: .notDirectory)
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
public actor InMemoryMediaListCache: MediaListCache {
  private var pages: [MediaKind?: MediaPage] = [:]

  public init() {}

  public func load(kind: MediaKind?) -> MediaPage? { pages[kind] }
  public func save(_ page: MediaPage, kind: MediaKind?) { pages[kind] = page }
  public func clear() { pages = [:] }
}

/// The one source of page 1 of the media list, shared by the gallery and the "Morph into" picker so they
/// agree on content and neither starts from a cold fetch. Seeds from memory, then disk; every network
/// answer replaces both. Outlives any single screen, which is what makes a re-open instant.
@MainActor
public final class MediaFirstPageStore {
  public let pageSize: Int

  private let api: any MediaAPI
  private let cache: any MediaListCache
  private var latest: [MediaKind?: MediaPage] = [:]
  /// Bumped by `invalidate()` so a response that was in flight at sign-out cannot repopulate the store.
  private var epoch = 0

  public init(api: any MediaAPI, cache: any MediaListCache = InMemoryMediaListCache(), pageSize: Int = 30) {
    self.api = api
    self.cache = cache
    self.pageSize = pageSize
  }

  /// The last page 1 seen for `kind`, from memory or else disk. `nil` on a cold first launch.
  public func seeded(kind: MediaKind?) async -> MediaPage? {
    if let page = latest[kind] { return page }
    let startedAt = epoch
    guard let page = await cache.load(kind: kind), startedAt == epoch else { return nil }
    // A refresh that landed while the disk read was pending is newer than what was read.
    if let newer = latest[kind] { return newer }
    latest[kind] = page
    return page
  }

  /// Fetches page 1 from the server and makes it the seed for the next open.
  public func refresh(kind: MediaKind?) async throws -> MediaPage {
    let startedAt = epoch
    let page = try await api.listMedia(kind: kind, page: 1, limit: pageSize)
    guard startedAt == epoch else { return page }
    latest[kind] = page
    await cache.save(page, kind: kind)
    return page
  }

  /// The session ended: forget everything the previous account saw.
  public func invalidate() async {
    epoch += 1
    latest = [:]
    await cache.clear()
  }
}
