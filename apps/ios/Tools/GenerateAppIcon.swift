#!/usr/bin/env swift
// Renders the app icon and launch mark into the asset catalog from the official brand mark, the same
// SVG the web NotebookSplash shows. Run from apps/ios on macOS 14+ (AppKit rasterizes the SVG):
//
//   swift Tools/GenerateAppIcon.swift
//
// Re-run it whenever the brand SVG changes; the PNGs it writes are committed.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let brandMarkPath = "../client/public/images/logos/Colored_Favicon.svg"
let catalog = "Bike4Mind/Resources/Assets.xcassets"

/// The brand SVG's 380x380 viewBox and the disc's gradient, in viewBox units. The icon background
/// reuses the gradient so the disc's edge all but disappears into a full-bleed square.
let viewBoxSide: CGFloat = 380
let gradientStart = CGPoint(x: 190, y: -15)
let gradientEnd = CGPoint(x: 185.5, y: 435.5)
let gradientTop = CGColor(srgbRed: 0x1A / 255, green: 0x38 / 255, blue: 0x96 / 255, alpha: 1)
let gradientBottom = CGColor(srgbRed: 0x0A / 255, green: 0x85 / 255, blue: 0xB4 / 255, alpha: 1)
/// The SVG markup the constants above copy; a brand update that changes it fails the run instead of
/// rendering the disc over a mismatched background.
let expectedGradientMarkup = [
  #"x1="190" y1="-15" x2="185.5" y2="435.5""#, ##"stop-color="#1A3896""##, ##"stop-color="#0A85B4""##,
]

let iconPixels = 1024
/// The disc's share of the icon width; leaves the glyph about 70% wide, clear of the corner mask.
let iconDiscFraction: CGFloat = 0.82
/// Inset of the rim clip, as a share of the disc; well inside the ring (about 6% of the disc wide).
let iconRimClipFraction: CGFloat = 0.01
let launchMarkPoints = 120

guard let brandMarkSource = try? String(contentsOfFile: brandMarkPath, encoding: .utf8),
  let brandMark = NSImage(contentsOfFile: brandMarkPath)
else {
  fatalError("could not load \(brandMarkPath); run from apps/ios")
}
for markup in expectedGradientMarkup where !brandMarkSource.contains(markup) {
  fatalError("\(brandMarkPath) no longer contains \(markup); update the gradient constants to match")
}

func makeContext(pixels: Int, opaque: Bool) -> CGContext {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
  let context = CGContext(
    data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info)!
  context.interpolationQuality = .high
  return context
}

func drawBrandMark(_ context: CGContext, in rect: CGRect) {
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  brandMark.draw(in: rect)
  NSGraphicsContext.restoreGraphicsState()
}

/// Maps a point in the SVG's y-down viewBox onto `rect` in a y-up context.
func project(_ point: CGPoint, into rect: CGRect) -> CGPoint {
  let scale = rect.width / viewBoxSide
  return CGPoint(x: rect.minX + point.x * scale, y: rect.maxY - point.y * scale)
}

func write(_ context: CGContext, to path: String) {
  let url = URL(fileURLWithPath: path)
  let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("could not write \(path)") }
  print("wrote \(path)")
}

// App icon: opaque, full-bleed square (the system applies the corner mask).
let icon = makeContext(pixels: iconPixels, opaque: true)
let discSide = CGFloat(iconPixels) * iconDiscFraction
let discInset = (CGFloat(iconPixels) - discSide) / 2
let discRect = CGRect(x: discInset, y: discInset, width: discSide, height: discSide)
let gradient = CGGradient(
  colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [gradientTop, gradientBottom] as CFArray,
  locations: [0, 1])!
icon.drawLinearGradient(
  gradient, start: project(gradientStart, into: discRect), end: project(gradientEnd, into: discRect),
  options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
// The SVG backs its disc with a white circle, which bleeds a hairline through the anti-aliased rim.
// The outer ring is pure gradient, so clipping just inside the rim leaves the glyph untouched.
icon.saveGState()
icon.addEllipse(in: discRect.insetBy(dx: discSide * iconRimClipFraction, dy: discSide * iconRimClipFraction))
icon.clip()
drawBrandMark(icon, in: discRect)
icon.restoreGState()
write(icon, to: "\(catalog)/AppIcon.appiconset/AppIcon-1024.png")

// Launch mark: the brand mark on transparency, centered on the launch background and reused as the
// Chat home greeting and sign-in mark.
for scale in 1...3 {
  let pixels = launchMarkPoints * scale
  let mark = makeContext(pixels: pixels, opaque: false)
  let rect = CGRect(x: 0, y: 0, width: pixels, height: pixels)
  let side = CGFloat(pixels)
  mark.saveGState()
  mark.addEllipse(in: rect.insetBy(dx: side * iconRimClipFraction, dy: side * iconRimClipFraction))
  mark.clip()
  drawBrandMark(mark, in: rect)
  mark.restoreGState()
  write(mark, to: "\(catalog)/LaunchMark.imageset/LaunchMark@\(scale)x.png")
}
