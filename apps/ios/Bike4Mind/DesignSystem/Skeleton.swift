import SwiftUI

/// A placeholder bar standing in for a line or block of content while it loads. Its height scales
/// with Dynamic Type; `widthFraction` is the share of the available width it fills.
struct SkeletonBlock: View {
  private let widthFraction: CGFloat
  private let alignment: Alignment
  private let cornerRadius: CGFloat
  private let fill: Color
  @ScaledMetric private var height: CGFloat

  init(
    widthFraction: CGFloat = 1, height: CGFloat = 14, alignment: Alignment = .leading,
    cornerRadius: CGFloat = Tokens.Radius.sm, fill: Color = Tokens.Palette.borderSoft
  ) {
    self.widthFraction = widthFraction
    self.alignment = alignment
    self.cornerRadius = cornerRadius
    self.fill = fill
    _height = ScaledMetric(wrappedValue: height)
  }

  var body: some View {
    GeometryReader { proxy in
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .fill(fill)
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
      .fill(Tokens.Palette.borderSoft)
      .aspectRatio(1, contentMode: .fit)
  }
}

/// Wraps skeleton shapes for one loading screen: a highlight sweeps across them (static under Reduce
/// Motion), and VoiceOver reads the whole placeholder as a single `label` element.
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
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Text(label))
  }
}

private struct ShimmerModifier: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var phase: CGFloat = 0

  func body(content: Content) -> some View {
    if reduceMotion {
      content
    } else {
      content
        .mask {
          // A band three widths wide slides from its dim tail to its dim head, so the bright middle
          // crosses the content once per cycle.
          GeometryReader { proxy in
            LinearGradient(
              stops: [
                .init(color: .black.opacity(0.45), location: 0.4),
                .init(color: .black, location: 0.5),
                .init(color: .black.opacity(0.45), location: 0.6),
              ],
              startPoint: .leading, endPoint: .trailing
            )
            .frame(width: proxy.size.width * 3)
            .offset(x: proxy.size.width * (2 * phase - 2))
          }
        }
        .onAppear {
          withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1 }
        }
    }
  }
}
