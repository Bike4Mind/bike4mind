#!/usr/bin/env swift  // Renders the placeholder app icon and launch mark into the asset catalog. Run from apps/ios:  //
//   swift Tools/GenerateAppIcon.swift
//
// The mark is three connected nodes (a small network) on a brand-blue gradient, no text. It is a
// stand-in so builds are shippable-looking: replace the PNGs in Bike4Mind/Resources/Assets.xcassets
// (AppIcon.appiconset/AppIcon-1024.png and LaunchMark.imageset) with final artwork whenever it exists;
// nothing else refers to this script.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let brand = CGColor(srgbRed: 0.310, green: 0.420, blue: 0.902, alpha: 1)
let brandDeep = CGColor(srgbRed: 0.180, green: 0.250, blue: 0.690, alpha: 1)
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

func makeContext(pixels: Int, opaque: Bool) -> CGContext {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
  let context = CGContext(
    data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info)!
  context.interpolationQuality = .high
  return context
}

/// Draws the mark inside a unit square scaled to `size`, in `color`.
func drawMark(_ context: CGContext, size: CGFloat, color: CGColor) {
  let nodes = [CGPoint(x: 0.5, y: 0.80), CGPoint(x: 0.22, y: 0.30), CGPoint(x: 0.78, y: 0.30)].map {
    CGPoint(x: $0.x * size, y: $0.y * size)
  }
  context.setStrokeColor(color)
  context.setFillColor(color)
  context.setLineWidth(size * 0.045)
  context.setLineCap(.round)
  context.move(to: nodes[0])
  context.addLine(to: nodes[1])
  context.addLine(to: nodes[2])
  context.closePath()
  context.strokePath()
  let radius = size * 0.105
  for node in nodes {
    context.fillEllipse(in: CGRect(x: node.x - radius, y: node.y - radius, width: radius * 2, height: radius * 2))
  }
  let core = size * 0.06
  context.fillEllipse(in: CGRect(x: size * 0.5 - core, y: size * 0.47 - core, width: core * 2, height: core * 2))
}

func write(_ context: CGContext, to path: String) {
  let url = URL(fileURLWithPath: path)
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("could not write \(path)") }
  print("wrote \(path)")
}

let catalog = "Bike4Mind/Resources/Assets.xcassets"

// App icon: opaque 1024 square (the system applies the corner mask).
let icon = makeContext(pixels: 1024, opaque: true)
let gradient = CGGradient(
  colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [brand, brandDeep] as CFArray, locations: [0, 1])!
icon.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 1024), end: CGPoint(x: 1024, y: 0), options: [])
icon.saveGState()
icon.translateBy(x: 192, y: 192)
drawMark(icon, size: 640, color: white)
icon.restoreGState()
write(icon, to: "\(catalog)/AppIcon.appiconset/AppIcon-1024.png")

// Launch mark: transparent, brand colored, shown centered on the launch background.
for scale in 1...3 {
  let pixels = 120 * scale
  let mark = makeContext(pixels: pixels, opaque: false)
  drawMark(mark, size: CGFloat(pixels), color: brand)
  write(mark, to: "\(catalog)/LaunchMark.imageset/LaunchMark@\(scale)x.png")
}

let launchMarkContents = """
  {
    "images" : [
      { "filename" : "LaunchMark@1x.png", "idiom" : "universal", "scale" : "1x" },
      { "filename" : "LaunchMark@2x.png", "idiom" : "universal", "scale" : "2x" },
      { "filename" : "LaunchMark@3x.png", "idiom" : "universal", "scale" : "3x" }
    ],
    "info" : { "author" : "xcode", "version" : 1 }
  }
  """
try launchMarkContents.write(
  toFile: "\(catalog)/LaunchMark.imageset/Contents.json", atomically: true, encoding: .utf8)
