#if canImport(UIKit)
  import UIKit

  public enum ScannedDocument {
    public enum Failure: Error { case noPages, invalidPage }

    public static func writePDF(pageCount: Int, page: (Int) -> UIImage) throws -> URL {
      guard pageCount > 0 else { throw Failure.noPages }
      let url = FileManager.default.temporaryDirectory.appending(path: "Scan-\(UUID().uuidString).pdf")
      let renderer = UIGraphicsPDFRenderer(bounds: .zero)
      do {
        var invalidPage = false
        try renderer.writePDF(to: url) { context in
          for index in 0..<pageCount {
            autoreleasepool {
              let image = page(index)
              guard image.size.width > 0, image.size.height > 0 else {
                invalidPage = true
                return
              }
              let bounds = CGRect(origin: .zero, size: image.size)
              context.beginPage(withBounds: bounds, pageInfo: [:])
              image.draw(in: bounds)
            }
          }
        }
        guard !invalidPage else { throw Failure.invalidPage }
        return url
      } catch {
        try? FileManager.default.removeItem(at: url)
        throw error
      }
    }
  }
#endif
