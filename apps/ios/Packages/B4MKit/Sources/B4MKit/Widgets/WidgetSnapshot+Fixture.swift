import Foundation

extension WidgetSnapshot {
  /// Canned data for `#Preview`s and `B4M_UI_FIXTURES=1` runs. `thumbnailFileName` is nil: fixtures
  /// carry no image bytes, so the widget draws its symbol placeholder.
  public static func fixture(now: Date = Date()) -> WidgetSnapshot {
    WidgetSnapshot(
      runningAgents: .init(
        count: 2,
        top: .init(sessionID: "fixture-0", title: "Quarterly metrics review", status: "running"),
        observedAt: now),
      credits: .init(balance: 31_667, observedAt: now),
      latestGeneration: .init(
        mediaID: "fixture-media-0", title: "Lighthouse at dusk", createdAt: now.addingTimeInterval(-1_800),
        thumbnailFileName: nil))
  }
}
