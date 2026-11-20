import Foundation

public enum WidgetSnapshotError: Error, Equatable, Sendable {
  /// The app-group container is unavailable: unit tests, an unsigned build, or a missing entitlement.
  case containerUnavailable
}

/// Where the snapshot lives. The app writes, the widget extension reads.
public protocol WidgetSnapshotStoring: Sendable {
  /// `nil` when nothing was written yet, the container is unavailable, or the file is unreadable.
  func load() -> WidgetSnapshot?
  func save(_ snapshot: WidgetSnapshot) throws
  /// Stores the latest-generation thumbnail and returns its file name, replacing any previous one.
  func saveThumbnail(_ data: Data, for mediaID: String) throws -> String
  func thumbnailURL(fileName: String) -> URL?
  /// Deletes the snapshot and every thumbnail. A missing container is already empty, so this never throws for it.
  func reset()
}

/// File-backed store inside the shared app-group container (or any directory, for tests).
///
/// A missing container never throws on read, so a widget with no data renders its placeholder instead
/// of failing; writes surface `containerUnavailable` so the caller can log and carry on.
public struct FileWidgetSnapshotStore: WidgetSnapshotStoring {
  private let directory: URL?

  /// - Parameter directory: where to keep the files; `nil` models an unavailable container.
  public init(directory: URL?) {
    self.directory = directory
  }

  /// The real store: the app-group container, or an always-empty store when the group is not granted.
  public static func appGroup(
    identifier: String = AppGroup.identifier, fileManager: FileManager = .default
  ) -> FileWidgetSnapshotStore {
    let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    return FileWidgetSnapshotStore(directory: container?.appending(path: "Widgets", directoryHint: .isDirectory))
  }

  private var snapshotURL: URL? { directory?.appending(path: "snapshot.json") }
  private var thumbnailsDirectory: URL? { directory?.appending(path: "thumbnails", directoryHint: .isDirectory) }

  public func load() -> WidgetSnapshot? {
    guard let snapshotURL, let data = try? Data(contentsOf: snapshotURL),
      let snapshot = try? Self.decoder.decode(WidgetSnapshot.self, from: data),
      snapshot.schemaVersion == WidgetSnapshot.currentSchemaVersion
    else { return nil }
    return snapshot
  }

  public func save(_ snapshot: WidgetSnapshot) throws {
    guard let directory, let snapshotURL else { throw WidgetSnapshotError.containerUnavailable }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Self.encoder.encode(snapshot).write(to: snapshotURL, options: .atomic)
  }

  public func saveThumbnail(_ data: Data, for mediaID: String) throws -> String {
    guard let thumbnailsDirectory else { throw WidgetSnapshotError.containerUnavailable }
    let fileManager = FileManager.default
    try fileManager.createDirectory(at: thumbnailsDirectory, withIntermediateDirectories: true)
    // Only the latest generation is ever shown, so older thumbnails are dead weight in the shared container.
    for stale in (try? fileManager.contentsOfDirectory(at: thumbnailsDirectory, includingPropertiesForKeys: nil)) ?? []
    {
      try? fileManager.removeItem(at: stale)
    }
    let fileName = "\(Self.safeFileComponent(mediaID)).img"
    try data.write(to: thumbnailsDirectory.appending(path: fileName), options: .atomic)
    return fileName
  }

  public func thumbnailURL(fileName: String) -> URL? {
    guard let thumbnailsDirectory, fileName == Self.safeFileComponent(fileName) else { return nil }
    let url = thumbnailsDirectory.appending(path: fileName)
    return FileManager.default.fileExists(atPath: url.path()) ? url : nil
  }

  public func reset() {
    guard let directory else { return }
    try? FileManager.default.removeItem(at: directory)
  }

  /// Ids come from the server; keep path punctuation out of file names.
  private static func safeFileComponent(_ value: String) -> String {
    String(value.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ".") ? $0 : "_" })
  }

  private static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .secondsSince1970
    encoder.outputFormatting = .sortedKeys
    return encoder
  }()

  private static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    return decoder
  }()
}

/// In-memory store for previews, fixture runs and tests.
public final class InMemoryWidgetSnapshotStore: WidgetSnapshotStoring, @unchecked Sendable {
  private let lock = NSLock()
  private var snapshot: WidgetSnapshot?
  private var thumbnails: [String: Data] = [:]

  public init(_ snapshot: WidgetSnapshot? = nil) {
    self.snapshot = snapshot
  }

  public func load() -> WidgetSnapshot? { lock.withLock { snapshot } }

  public func save(_ snapshot: WidgetSnapshot) throws { lock.withLock { self.snapshot = snapshot } }

  public func saveThumbnail(_ data: Data, for mediaID: String) throws -> String {
    lock.withLock {
      thumbnails.removeAll()
      thumbnails[mediaID] = data
      return mediaID
    }
  }

  public func thumbnailURL(fileName: String) -> URL? { nil }

  public func reset() {
    lock.withLock {
      snapshot = nil
      thumbnails.removeAll()
    }
  }

  public func thumbnailData(fileName: String) -> Data? { lock.withLock { thumbnails[fileName] } }
}
