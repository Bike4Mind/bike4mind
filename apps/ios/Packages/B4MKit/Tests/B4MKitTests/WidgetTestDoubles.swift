import Foundation

@testable import B4MKit

/// Records which widget kinds were asked to reload.
final class RecordingReloader: WidgetTimelineReloading, @unchecked Sendable {
  private let lock = NSLock()
  private var calls: [[String]] = []

  var reloads: [[String]] { lock.withLock { calls } }

  func reload(kinds: [String]) { lock.withLock { calls.append(kinds) } }
}

/// A store whose container is gone, like an unsigned build or a unit-test host.
func unavailableStore() -> FileWidgetSnapshotStore { FileWidgetSnapshotStore(directory: nil) }

func temporaryDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appending(path: "b4m-widgets-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

let referenceDate = Date(timeIntervalSince1970: 1_800_000_000)
