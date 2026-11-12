import SwiftUI

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif

/// The Bike4Mind brand palette, ported from the web app's Joy theme
/// (apps/client/app/utils/themes/themePrimitives.ts and components/*.ts).
/// Every color resolves per light/dark at render time, so the same token works in the
/// app, the widget extension and the share extension. Keep the values in sync with the
/// web theme; the source token is named next to each color.
public enum BrandTheme {
  // MARK: - Accent

  /// Interactive blue (web `reading.accent`: #0B6BCB light, #61AFEF dark). The asset-catalog
  /// AccentColor in each target carries the same pair so stock controls match.
  public static let accent = brandColor(light: Self.accentLight, dark: Self.accentDark)

  // MARK: - Backgrounds

  /// Screen background (web `background.body`: #FBFCFE light, #0E1214 dark).
  public static let backgroundBody = brandColor(
    light: RGBA(0xFBFCFE), dark: RGBA(0x0E1214))

  /// Raised surface for cards, list rows and input fields
  /// (web `background.surface`/`surface2`: #F4F7F9 light, #13181C dark).
  public static let surface = brandColor(light: RGBA(0xF4F7F9), dark: RGBA(0x13181C))

  /// Hairline borders and dividers (web `divider`: #D3DFE8 light, #2C3135 dark).
  public static let divider = brandColor(light: RGBA(0xD3DFE8), dark: RGBA(0x2C3135))

  // MARK: - Text

  /// Primary ink (web `text.primary`: #335F70 light, #D1E4F4 dark).
  public static let textPrimary = brandColor(light: RGBA(0x335F70), dark: RGBA(0xD1E4F4))

  /// Secondary ink. The web's secondary tier is nearly opaque, so this uses the tertiary
  /// alphas (0.9 light, 0.7 dark over the primary ink) to keep a visible hierarchy on iOS.
  public static let textSecondary = brandColor(
    light: RGBA(0x335F70, alpha: 0.9), dark: RGBA(0xD1E4F4, alpha: 0.7))

  // MARK: - Chat bubbles

  /// The user's bubble: a tint of the accent with primary text on top; stays legible where
  /// the dark-mode accent is too light for white text. Dark mode needs a much stronger
  /// tint, because 16% of the accent over near-black reads as black.
  public static let userBubble = brandColor(
    light: Self.accentLight.withAlpha(0.16), dark: Self.accentDark.withAlpha(0.42))

  /// The assistant's bubble (web `chatbox.replyBg`: #E2ECF4 light, #2A4159 dark).
  public static let assistantBubble = brandColor(light: RGBA(0xE2ECF4), dark: RGBA(0x2A4159))

  // MARK: - Status

  /// Destructive red (web `danger.solidBg` #DA3131 light; `danger.mainChannel` #EF4444 dark,
  /// which reads better than the solid on near-black).
  public static let destructive = brandColor(light: RGBA(0xDA3131), dark: RGBA(0xEF4444))

  /// Warning orange (web `warning.solidBg`: #FFA500 in both modes).
  public static let warning = brandColor(light: RGBA(0xFFA500), dark: RGBA(0xFFA500))

  /// Success green (web `success.solidBg` #1FB84B light; `success.softColor` #34D399 dark).
  public static let success = brandColor(light: RGBA(0x1FB84B), dark: RGBA(0x34D399))

  // MARK: - Values

  static let accentLight = RGBA(0x0B6BCB)
  static let accentDark = RGBA(0x61AFEF)

  /// An sRGB color value, written as 0xRRGGBB plus an alpha, so the palette above reads
  /// like the web theme it mirrors.
  struct RGBA: Equatable {
    let red: Double
    let green: Double
    let blue: Double
    let alpha: Double

    init(_ rgb: UInt32, alpha: Double = 1.0) {
      self.red = Double((rgb >> 16) & 0xFF) / 255.0
      self.green = Double((rgb >> 8) & 0xFF) / 255.0
      self.blue = Double(rgb & 0xFF) / 255.0
      self.alpha = alpha
    }

    func withAlpha(_ alpha: Double) -> RGBA {
      RGBA(red: red, green: green, blue: blue, alpha: alpha)
    }

    private init(red: Double, green: Double, blue: Double, alpha: Double) {
      self.red = red
      self.green = green
      self.blue = blue
      self.alpha = alpha
    }
  }

  private static func brandColor(light: RGBA, dark: RGBA) -> Color {
    #if canImport(UIKit)
      return Color(
        uiColor: UIColor { traits in
          let value = traits.userInterfaceStyle == .dark ? dark : light
          return UIColor(
            red: value.red, green: value.green, blue: value.blue, alpha: value.alpha)
        })
    #elseif canImport(AppKit)
      return Color(
        nsColor: NSColor(
          name: nil,
          dynamicProvider: { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let value = isDark ? dark : light
            return NSColor(
              srgbRed: value.red, green: value.green, blue: value.blue, alpha: value.alpha)
          }))
    #else
      return Color(
        red: light.red, green: light.green, blue: light.blue, opacity: light.alpha)
    #endif
  }
}
