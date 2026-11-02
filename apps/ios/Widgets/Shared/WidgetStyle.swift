import SwiftUI
import WidgetKit

/// Visual constants shared by the home-screen widgets (and, with M5, the Live Activity views).
enum WidgetStyle {
  static let placeholderMessage = "Open Bike4Mind to get started"

  static func title(_ text: String) -> some View {
    Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
  }
}

extension View {
  /// iOS 17 requires every widget to declare its background through `containerBackground`.
  func widgetBackground() -> some View {
    containerBackground(.fill.tertiary, for: .widget)
  }
}
