import B4MKit
import SwiftUI
import WidgetKit

/// Visual constants shared by the home-screen widgets and the Live Activity views.
enum WidgetStyle {
  static let placeholderMessage = "Open Bike4Mind to get started"

  static func color(for tone: QuestActivityPresentation.Tone) -> Color {
    switch tone {
    case .active: .accentColor
    case .attention: BrandTheme.warning
    case .success: BrandTheme.success
    case .failure: BrandTheme.destructive
    case .neutral: .secondary
    }
  }

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
