import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// An sRGB color value written as 0xRRGGBB plus an alpha, the shape the generated
/// `BrandTokens` (Theme/Generated, from packages/design-tokens) is written in.
public struct BrandRGBA: Equatable, Sendable {
  public let red: Double
  public let green: Double
  public let blue: Double
  public let alpha: Double

  public init(_ rgb: UInt32, alpha: Double = 1.0) {
    self.red = Double((rgb >> 16) & 0xFF) / 255.0
    self.green = Double((rgb >> 8) & 0xFF) / 255.0
    self.blue = Double(rgb & 0xFF) / 255.0
    self.alpha = alpha
  }
}

/// One color role: the value for each appearance.
public struct BrandColorPair: Equatable, Sendable {
  public let light: BrandRGBA
  public let dark: BrandRGBA

  public init(light: BrandRGBA, dark: BrandRGBA) {
    self.light = light
    self.dark = dark
  }
}

/// The Bike4Mind brand palette as SwiftUI colors. The values are generated from the web theme's
/// tokens (`BrandTokens.Colors`, see apps/ios/DESIGN_PARITY.md); never hand-copy a hex here.
/// Every color resolves per light/dark at render time, so the same token works in the app, the
/// widget extension and the share extension.
public enum BrandTheme {
  public static let accent = color(BrandTokens.Colors.accent)
  public static let backgroundBody = color(BrandTokens.Colors.backgroundBody)
  public static let surface = color(BrandTokens.Colors.surface)
  public static let panel = color(BrandTokens.Colors.panel)
  public static let promptBubble = color(BrandTokens.Colors.promptBubble)
  public static let borderSoft = color(BrandTokens.Colors.borderSoft)
  public static let borderSolid = color(BrandTokens.Colors.borderSolid)
  public static let divider = color(BrandTokens.Colors.divider)
  public static let textPrimary = color(BrandTokens.Colors.textPrimary)
  public static let textSecondary = color(BrandTokens.Colors.textSecondary)
  public static let readingInk = color(BrandTokens.Colors.readingInk)
  public static let composerPlaceholder = color(BrandTokens.Colors.composerPlaceholder)
  public static let sendButton = color(BrandTokens.Colors.sendButton)
  public static let codeSurface = color(BrandTokens.Colors.codeSurface)
  public static let codeFrame = color(BrandTokens.Colors.codeFrame)
  public static let sidebar = color(BrandTokens.Colors.sidebar)
  public static let sidebarText = color(BrandTokens.Colors.sidebarText)
  public static let sidebarSelected = color(BrandTokens.Colors.sidebarSelected)
  public static let destructive = color(BrandTokens.Colors.destructive)
  public static let warning = color(BrandTokens.Colors.warning)
  public static let success = color(BrandTokens.Colors.success)

  /// A SwiftUI color that resolves the pair against the current appearance.
  public static func color(_ pair: BrandColorPair) -> Color {
    #if canImport(UIKit)
      return Color(
        uiColor: UIColor { traits in
          let value = traits.userInterfaceStyle == .dark ? pair.dark : pair.light
          return UIColor(
            red: value.red, green: value.green, blue: value.blue, alpha: value.alpha)
        })
    #elseif canImport(AppKit)
      return Color(
        nsColor: NSColor(
          name: nil,
          dynamicProvider: { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let value = isDark ? pair.dark : pair.light
            return NSColor(
              srgbRed: value.red, green: value.green, blue: value.blue, alpha: value.alpha)
          }))
    #else
      return Color(
        red: pair.light.red, green: pair.light.green, blue: pair.light.blue,
        opacity: pair.light.alpha)
    #endif
  }
}

/// The web type face, Libre Franklin, at token sizes and CSS weights, scaled with Dynamic Type
/// relative to a text style.
///
/// The app target bundles the variable font (Resources/Fonts, registered through UIAppFonts);
/// SwiftUI's weight on the family drives its `wght` axis, so every weight is a real cut. Where the
/// font is not registered (widgets, the share extension) SwiftUI falls back to the system face.
public enum BrandFont {
  public static func font(
    size: CGFloat, weight: Int = 400, relativeTo textStyle: Font.TextStyle = .body
  ) -> Font {
    Font.custom(BrandTokens.Typography.familyName, size: size, relativeTo: textStyle)
      .weight(fontWeight(weight))
  }

  /// Extra line spacing that turns the font's natural leading into a web line height (a multiple
  /// of the font size), the way CSS `line-height` does.
  public static func lineSpacing(size: CGFloat, lineHeight: CGFloat) -> CGFloat {
    max(0, size * lineHeight - size * naturalLineHeightMultiple)
  }

  /// Libre Franklin's (ascender + descender + line gap) / em, from the font's hhea table.
  static let naturalLineHeightMultiple: CGFloat = 1.212

  static func fontWeight(_ cssWeight: Int) -> Font.Weight {
    switch cssWeight {
    case ..<150: .ultraLight
    case ..<250: .thin
    case ..<350: .light
    case ..<450: .regular
    case ..<550: .medium
    case ..<650: .semibold
    case ..<750: .bold
    case ..<850: .heavy
    default: .black
    }
  }
}
