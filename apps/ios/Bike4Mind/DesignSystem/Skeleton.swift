import SwiftUI

// Opaque in both schemes: borderSoft is 8% alpha in dark mode, which the shimmer's dim band erases.
private let skeletonFill = Tokens.Palette.divider

/// A placeholder bar standing in for a line or block of content while it loads. Its height scales
/// with Dynamic Type; `widthFraction` is the share of the available width it fills.
struct SkeletonBlock: View {
  private let widthFraction: CGFloat
  private let alignment: Alignment
  private let cornerRadius: CGFloat
  @ScaledMetric private var height: CGFloat

  init(
    widthFraction: CGFloat = 1, height: CGFloat = 14, alignment: Alignment = .leading,
    cornerRadius: CGFloat = Tokens.Radius.sm
  ) {
    self.widthFraction = widthFraction
    self.alignment = alignment
    self.cornerRadius = cornerRadius
    _height = ScaledMetric(wrappedValue: height)
  }

  var body: some View {
    GeometryReader { proxy in
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(skeletonFill)
        .frame(width: proxy.size.width * widthFraction)
        .frame(maxWidth: .infinity, alignment: alignment)
    }
    .frame(height: height)
  }
}

/// A square placeholder for a grid cell such as a media thumbnail.
struct SkeletonTile: View {
  var body: some View {
    Rectangle()
      .fill(skeletonFill)
      .aspectRatio(1, contentMode: .fit)
  }
}

/// Wraps skeleton shapes for one loading screen: a highlight sweeps across them (static under Reduce
/// Motion), and VoiceOver reads the whole placeholder as a single `label` element. Fills the space
/// it is offered from the top and clips, since large Dynamic Type sizes can grow it past the screen.
struct SkeletonContainer<Content: View>: View {
  private let label: LocalizedStringKey
  private let content: Content

  init(label: LocalizedStringKey, @ViewBuilder content: () -> Content) {
    self.label = label
    self.content = content()
  }

  var body: some View {
    content
      .modifier(ShimmerModifier())
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .clipped()
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(label))
  }
}

private struct ShimmerModifier: ViewModifier {
  private static let period: TimeInterval = 1.4

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @State private var isOnScreen = false

  func body(content: Content) -> some View {
    // The Reduce Motion branch lives inside the mask so the content keeps one identity and its
    // appear/disappear events stay paired when the setting flips.
    content
      .mask {
        if reduceMotion {
          Color.black
        } else {
          // Phase comes from the frame clock rather than an animated state value, so the sweep
          // restarts after a Reduce Motion toggle and no layout change rides an animation transaction.
          // Paused while covered by a pushed screen or the app is inactive, so it stops redrawing.
          TimelineView(.animation(minimumInterval: nil, paused: !isOnScreen || scenePhase != .active)) {
            timeline in
            let elapsed = timeline.date.timeIntervalSinceReferenceDate
            let phase = CGFloat(elapsed.truncatingRemainder(dividingBy: Self.period) / Self.period)
            // A band three widths wide slides from its dim tail to its dim head, so the bright middle
            // crosses the content once per cycle.
            GeometryReader { proxy in
              LinearGradient(
                stops: [
                  .init(color: .black.opacity(0.55), location: 0.4),
                  .init(color: .black, location: 0.5),
                  .init(color: .black.opacity(0.55), location: 0.6),
                ],
                startPoint: .leading, endPoint: .trailing
              )
              .frame(width: proxy.size.width * 3)
              .offset(x: proxy.size.width * (2 * phase - 2))
            }
          }
        }
      }
      .onAppear { isOnScreen = true }
      .onDisappear { isOnScreen = false }
  }
}
