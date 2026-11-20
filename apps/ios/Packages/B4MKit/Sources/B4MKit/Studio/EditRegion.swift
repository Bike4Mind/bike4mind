import CoreGraphics
import Foundation

/// One box a person drew on an image, with what should change inside it. `rect` is normalised to the
/// image (0-1 on both axes, origin top-left), so it survives any change in how big the image is drawn.
public struct EditRegion: Identifiable, Equatable, Sendable {
  public let id: UUID
  public var rect: CGRect
  public var prompt: String

  public init(id: UUID = UUID(), rect: CGRect, prompt: String = "") {
    self.id = id
    self.rect = rect
    self.prompt = prompt
  }

  /// `[y_min, x_min, y_max, x_max]`, the BFL order the image-edits route takes (vertical axis first).
  public var bbox: [Double] {
    [rect.minY, rect.minX, rect.maxY, rect.maxX].map { Double($0) }
  }
}

/// Maps between where a box is drawn on screen and where it sits in the image.
public enum RegionGeometry {
  /// The server allows at most this many regions per edit.
  public static let maximumRegions = 8

  /// Smallest box side, as a fraction of the image. The server only needs a box to survive snapping to its
  /// 0-1000 grid; this is larger so a stray tap does not become a region.
  public static let minimumSide: CGFloat = 0.02

  /// Where an image of `imageSize` lands when aspect-fit and centred in `container`.
  public static func fittedFrame(imageSize: CGSize, in container: CGSize) -> CGRect {
    guard imageSize.width > 0, imageSize.height > 0, container.width > 0, container.height > 0 else { return .zero }
    let scale = min(container.width / imageSize.width, container.height / imageSize.height)
    let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
    return CGRect(
      x: (container.width - size.width) / 2, y: (container.height - size.height) / 2,
      width: size.width, height: size.height)
  }

  /// A rect drawn in view space, clipped to the image and normalised; `nil` when what is left is too small.
  public static func normalized(_ viewRect: CGRect, imageFrame: CGRect) -> CGRect? {
    guard imageFrame.width > 0, imageFrame.height > 0 else { return nil }
    let clipped = viewRect.standardized.intersection(imageFrame)
    guard !clipped.isNull else { return nil }
    let rect = CGRect(
      x: (clipped.minX - imageFrame.minX) / imageFrame.width,
      y: (clipped.minY - imageFrame.minY) / imageFrame.height,
      width: clipped.width / imageFrame.width,
      height: clipped.height / imageFrame.height)
    guard rect.width >= minimumSide, rect.height >= minimumSide else { return nil }
    return rect
  }

  /// The inverse of `normalized`: where a stored region is drawn for the current layout.
  public static func viewRect(_ normalized: CGRect, imageFrame: CGRect) -> CGRect {
    CGRect(
      x: imageFrame.minX + normalized.minX * imageFrame.width,
      y: imageFrame.minY + normalized.minY * imageFrame.height,
      width: normalized.width * imageFrame.width,
      height: normalized.height * imageFrame.height)
  }
}
