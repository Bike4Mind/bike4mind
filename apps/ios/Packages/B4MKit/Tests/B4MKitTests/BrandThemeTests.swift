import SwiftUI
import XCTest

@testable import B4MKit

final class BrandThemeTests: XCTestCase {
  func testRGBAUnpacksHexComponents() {
    let value = BrandRGBA(0x0B6BCB)
    XCTAssertEqual(value.red, 11.0 / 255.0, accuracy: 0.0001)
    XCTAssertEqual(value.green, 107.0 / 255.0, accuracy: 0.0001)
    XCTAssertEqual(value.blue, 203.0 / 255.0, accuracy: 0.0001)
    XCTAssertEqual(value.alpha, 1.0)
  }

  func testRGBAKeepsAlpha() {
    let value = BrandRGBA(0x61AFEF, alpha: 0.42)
    XCTAssertEqual(value.red, 97.0 / 255.0, accuracy: 0.0001)
    XCTAssertEqual(value.alpha, 0.42)
  }

  func testRadiiFollowTheWebScale() {
    XCTAssertEqual(BrandTokens.Radius.sm, 6)
    XCTAssertEqual(BrandTokens.Radius.md, 8)
    XCTAssertEqual(BrandTokens.Radius.lg, 12)
    XCTAssertEqual(BrandTokens.Radius.xl, 16)
  }

  func testLineSpacingTurnsNaturalLeadingIntoWebLineHeight() {
    XCTAssertEqual(BrandFont.lineSpacing(size: 16, lineHeight: 1.5), 16 * (1.5 - 1.212), accuracy: 0.0001)
    XCTAssertEqual(BrandFont.lineSpacing(size: 16, lineHeight: 1.0), 0)
  }

  func testFontWeightMapsCSSWeights() {
    XCTAssertEqual(BrandFont.fontWeight(400), .regular)
    XCTAssertEqual(BrandFont.fontWeight(BrandTokens.Typography.Weight.md), .medium)
    XCTAssertEqual(BrandFont.fontWeight(BrandTokens.Typography.Weight.lg), .semibold)
  }

  #if canImport(UIKit)
    private func components(
      of color: Color, dark: Bool
    ) -> (
      red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat
    ) {
      let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
      let resolved = UIColor(color).resolvedColor(with: traits)
      var red: CGFloat = 0
      var green: CGFloat = 0
      var blue: CGFloat = 0
      var alpha: CGFloat = 0
      resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
      return (red, green, blue, alpha)
    }

    func testAccentResolvesPerAppearance() {
      let light = components(of: BrandTheme.accent, dark: false)
      XCTAssertEqual(light.red, 11.0 / 255.0, accuracy: 0.0001)
      XCTAssertEqual(light.blue, 203.0 / 255.0, accuracy: 0.0001)

      let dark = components(of: BrandTheme.accent, dark: true)
      XCTAssertEqual(dark.red, 97.0 / 255.0, accuracy: 0.0001)
      XCTAssertEqual(dark.blue, 239.0 / 255.0, accuracy: 0.0001)
    }

    func testPromptBubbleBorderIsTheSoftWebHairline() {
      XCTAssertEqual(components(of: BrandTheme.borderSoft, dark: false).alpha, 0.5, accuracy: 0.0001)
      XCTAssertEqual(components(of: BrandTheme.borderSoft, dark: true).alpha, 0.08, accuracy: 0.0001)
    }

    func testTextTokensResolvePerAppearance() {
      let light = components(of: BrandTheme.textPrimary, dark: false)
      XCTAssertEqual(light.red, 51.0 / 255.0, accuracy: 0.0001)
      XCTAssertEqual(light.green, 95.0 / 255.0, accuracy: 0.0001)

      let dark = components(of: BrandTheme.textPrimary, dark: true)
      XCTAssertEqual(dark.red, 209.0 / 255.0, accuracy: 0.0001)
      XCTAssertEqual(dark.green, 228.0 / 255.0, accuracy: 0.0001)

      XCTAssertEqual(
        components(of: BrandTheme.textSecondary, dark: false).alpha, 0.9, accuracy: 0.0001)
      XCTAssertEqual(
        components(of: BrandTheme.textSecondary, dark: true).alpha, 0.7, accuracy: 0.0001)
    }
  #endif
}
