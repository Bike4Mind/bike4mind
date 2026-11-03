import B4MKit
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

  /// The values live in B4MKit's BrandTheme (shared with the widget and share extensions);
  /// Assets.xcassets/AccentColor must carry the same accent pair for stock controls.
  enum Palette {
    static let brand = BrandTheme.accent
    static let background = BrandTheme.backgroundBody
    static let groupedBackground = BrandTheme.surface
    static let primaryText = BrandTheme.textPrimary
    static let secondaryText = BrandTheme.textSecondary
    static let destructive = BrandTheme.destructive
    static let userBubble = BrandTheme.userBubble
    static let assistantBubble = BrandTheme.assistantBubble
    static let warning = BrandTheme.warning
    static let divider = BrandTheme.divider
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

extension View {
  /// Brand chrome for a List or Form screen: hides the system scroll background and paints the
  /// brand body color behind it. Rows set `.listRowBackground` themselves (surface for grouped
  /// forms, clear for plain lists).
  func brandedListChrome() -> some View {
    scrollContentBackground(.hidden).background(Tokens.Palette.background)
  }
}
