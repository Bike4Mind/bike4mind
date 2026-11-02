import SwiftUI

/// The one place visual constants live. Colors resolve per light/dark through the asset catalog
/// or semantic system colors; never hard-code a color in a view.
enum Tokens {
  enum Spacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 16
    static let l: CGFloat = 24
    static let xl: CGFloat = 32
    static let xxl: CGFloat = 48
  }

  enum Radius {
    static let control: CGFloat = 12
    static let card: CGFloat = 16
    static let bubble: CGFloat = 18
  }

  enum Palette {
    /// Brand accent, defined for light and dark in Assets.xcassets/AccentColor.
    static let brand = Color.accentColor
    static let background = Color(uiColor: .systemBackground)
    static let groupedBackground = Color(uiColor: .systemGroupedBackground)
    static let secondaryText = Color.secondary
    static let destructive = Color.red
    /// A tint of the brand colour with primary text on top; stays legible where the dark-mode accent is too light for white text.
    static let userBubble = Color.accentColor.opacity(0.16)
    static let assistantBubble = Color(uiColor: .secondarySystemBackground)
    static let warning = Color.orange
  }

  enum Typography {
    static let wordmark = Font.system(.largeTitle, design: .rounded, weight: .bold)
    static let tagline = Font.title3
    static let caption = Font.footnote
    static let meta = Font.caption2
  }

  enum Layout {
    /// Keeps the sign-in column readable on iPad and in landscape.
    static let readableWidth: CGFloat = 420
    /// Keeps chat bubbles from stretching edge to edge on iPad and in landscape.
    static let bubbleMaxWidth: CGFloat = 560
  }
}
