import B4MKit
import SwiftUI

/// The one place visual constants live. Values come from the web theme's design tokens
/// (`BrandTokens`, generated into B4MKit; see apps/ios/DESIGN_PARITY.md). Never hard-code a color,
/// radius or font size in a view.
enum Tokens {
  enum Spacing {
    static let xs = BrandTokens.Spacing.xs
    static let s = BrandTokens.Spacing.s
    static let m = BrandTokens.Spacing.m
    static let l = BrandTokens.Spacing.l
    static let xl = BrandTokens.Spacing.xl
    static let xxl = BrandTokens.Spacing.xxl
  }

  /// The web radius scale: sm for buttons and code panels, md for bubbles, rows and cards.
  enum Radius {
    static let sm = BrandTokens.Radius.sm
    static let md = BrandTokens.Radius.md
    static let lg = BrandTokens.Radius.lg
    static let xl = BrandTokens.Radius.xl
  }

  enum Palette {
    static let brand = BrandTheme.accent
    static let background = BrandTheme.backgroundBody
    static let groupedBackground = BrandTheme.surface
    static let panel = BrandTheme.panel
    static let primaryText = BrandTheme.textPrimary
    static let secondaryText = BrandTheme.textSecondary
    static let readingInk = BrandTheme.readingInk
    static let promptBubble = BrandTheme.promptBubble
    static let borderSoft = BrandTheme.borderSoft
    static let borderSolid = BrandTheme.borderSolid
    static let composerPlaceholder = BrandTheme.composerPlaceholder
    static let sendButton = BrandTheme.sendButton
    static let codeSurface = BrandTheme.codeSurface
    static let codeFrame = BrandTheme.codeFrame
    static let sidebar = BrandTheme.sidebar
    static let sidebarText = BrandTheme.sidebarText
    static let sidebarSelected = BrandTheme.sidebarSelected
    static let destructive = BrandTheme.destructive
    static let warning = BrandTheme.warning
    static let divider = BrandTheme.divider
  }

  /// Libre Franklin on the web type ramp; each size scales with Dynamic Type.
  enum Typography {
    private typealias Size = BrandTokens.Typography.Size
    private typealias Weight = BrandTokens.Typography.Weight

    static let wordmark = BrandFont.font(size: Size.xl3, weight: Weight.xl, relativeTo: .largeTitle)
    static let tagline = BrandFont.font(size: Size.lg, relativeTo: .title3)
    /// The empty-home greeting (web h3, weight 500).
    static let greeting = BrandFont.font(size: Size.xl2, weight: Weight.md, relativeTo: .title2)
    /// Chat prose: replies, prompts and the composer (web body-md).
    static let body = BrandFont.font(size: Size.md)
    /// Drawer rows (web body-sm).
    static let row = BrandFont.font(size: Size.sm, relativeTo: .subheadline)
    static let caption = BrandFont.font(size: Size.sm, relativeTo: .footnote)
    static let meta = BrandFont.font(size: Size.xs, relativeTo: .caption2)
    static let code = Font.system(size: Size.sm, design: .monospaced).leading(.standard)
    /// Reply headings, h1 to h6 (web `.b4m-md` headings, weight 600); h4 and below stay body size.
    static func heading(level: Int) -> Font {
      switch level {
      case 1: BrandFont.font(size: Size.xl2, weight: Weight.lg, relativeTo: .title2)
      case 2: BrandFont.font(size: Size.xl, weight: Weight.lg, relativeTo: .title3)
      case 3: BrandFont.font(size: Size.lg, weight: Weight.lg, relativeTo: .headline)
      default: BrandFont.font(size: Size.md, weight: Weight.lg, relativeTo: .headline)
      }
    }
    static let codeLabel = Font.system(size: Size.xs, design: .monospaced)
  }

  enum LineSpacing {
    /// Reply prose: the web `.b4m-md` line height of 1.68.
    static let reply = BrandFont.lineSpacing(size: BrandTokens.Typography.Size.md, lineHeight: 1.68)
    /// Prompts and other body text (web line height md, 1.5).
    static let body = BrandFont.lineSpacing(
      size: BrandTokens.Typography.Size.md, lineHeight: BrandTokens.Typography.LineHeight.md)
  }

  enum Layout {
    /// Keeps the sign-in column readable on iPad and in landscape.
    static let readableWidth: CGFloat = 420
    /// Keeps the transcript column from stretching edge to edge on iPad and in landscape.
    static let transcriptMaxWidth: CGFloat = 760
    /// The web prompt bubble's share of the column (UserPrompt maxWidth 78%).
    static let promptWidthFraction: CGFloat = 0.78
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
