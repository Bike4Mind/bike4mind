import B4MKit
import Foundation

/// The extension's one read path to app data: the snapshot the app wrote into the shared app-group
/// container. No network, no auth session. When the container is unavailable this yields `nil`, which
/// every widget renders as its "open the app" placeholder.
enum WidgetData {
  static func store() -> any WidgetSnapshotStoring {
    FileWidgetSnapshotStore.appGroup()
  }

  static func mapper(now: Date = Date()) -> WidgetEntryMapper {
    WidgetEntryMapper(snapshot: store().load(), now: now)
  }
}
