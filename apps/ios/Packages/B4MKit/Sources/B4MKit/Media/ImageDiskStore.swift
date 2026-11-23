import CryptoKit
import Foundation

/// Original image bytes kept on disk across launches, keyed like `ThumbnailCache` (the URL without its
/// signature). Least recently read files go first once the store passes `byteLimit`.
///
/// Relies on the same assumption as the in-memory tier: a media path names immutable bytes, so a stored file
/// never goes stale.
public final class ImageDiskStore: @unchecked Sendable {
  public let directory: URL
  public let byteLimit: Int
  private let fileManager = FileManager.default
  // Serialises writes, trims and wipes, and guards `generation`.
  private let lock = NSLock()
  private var _generation: UInt64 = 0

  public init(directory: URL, byteLimit: Int) {
    self.directory = directory
    self.byteLimit = byteLimit
  }

  /// Bumped by `removeAll`. A writer captures it before downloading so bytes fetched for a session that has
  /// since ended are dropped instead of landing in the wiped store.
  public var generation: UInt64 { lock.withLock { _generation } }

  public func data(for key: String) -> Data? {
    let file = fileURL(for: key)
    guard let data = try? Data(contentsOf: file) else { return nil }
    // The modification date is the recency `trim` evicts by.
    try? fileManager.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
    return data
  }

  public func store(_ data: Data, for key: String, generation: UInt64) {
    guard data.count <= byteLimit else { return }
    lock.withLock {
      guard generation == _generation else { return }
      do {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: fileURL(for: key), options: .atomic)
      } catch {
        return
      }
      trim()
    }
  }

  public func remove(for key: String) {
    lock.withLock { try? fileManager.removeItem(at: fileURL(for: key)) }
  }

  public func removeAll() {
    lock.withLock {
      _generation += 1
      try? fileManager.removeItem(at: directory)
    }
  }

  /// Must run under `lock`.
  private func trim() {
    let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
    guard
      let files = try? fileManager.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: Array(keys), options: .skipsHiddenFiles)
    else { return }
    var entries = files.compactMap { url -> (url: URL, size: Int, date: Date)? in
      guard let values = try? url.resourceValues(forKeys: keys) else { return nil }
      return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
    }
    var total = entries.reduce(0) { $0 + $1.size }
    guard total > byteLimit else { return }
    entries.sort { $0.date < $1.date }
    for entry in entries where total > byteLimit {
      try? fileManager.removeItem(at: entry.url)
      total -= entry.size
    }
  }

  /// Hashed so the file name carries no path from the URL and has a fixed length.
  private func fileURL(for key: String) -> URL {
    let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(digest, isDirectory: false)
  }
}
