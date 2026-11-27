#if canImport(UIKit)
  import PDFKit
  import UIKit
  import XCTest

  @testable import B4MKit

  final class ScannedDocumentTests: XCTestCase {
    func testThreePagesBecomeOnePDFInCaptureOrder() async throws {
      let sizes = [CGSize(width: 200, height: 300), CGSize(width: 400, height: 200), CGSize(width: 150, height: 250)]
      var requested: [Int] = []
      let url = try ScannedDocument.writePDF(pageCount: sizes.count) { index in
        requested.append(index)
        return UIGraphicsImageRenderer(size: sizes[index]).image { context in
          UIColor.white.setFill()
          context.fill(CGRect(origin: .zero, size: sizes[index]))
          "Page \(index + 1)".draw(at: CGPoint(x: 10, y: 10), withAttributes: [.foregroundColor: UIColor.black])
        }
      }
      defer { try? FileManager.default.removeItem(at: url) }
      let document = try XCTUnwrap(PDFDocument(url: url))
      XCTAssertEqual(requested, [0, 1, 2])
      XCTAssertEqual(document.pageCount, 3)
      for index in sizes.indices {
        XCTAssertEqual(document.page(at: index)?.bounds(for: .mediaBox).size, sizes[index])
      }
      let loaded = try await ShareItemLoader().load(LocalFileAttachment(fileURL: url, type: .pdf))
      guard case .pdf(let file) = loaded else { return XCTFail("Scan must enter capture as one PDF") }
      XCTAssertEqual(file.mimeType, "application/pdf")
      XCTAssertGreaterThan(file.byteCount, 0)
    }

    func testEmptyScanIsRejected() {
      XCTAssertThrowsError(
        try ScannedDocument.writePDF(pageCount: 0) { _ in
          XCTFail("An empty scan must not request a page")
          return UIImage()
        })
    }

    func testInvalidPageIsRejectedRatherThanSendingAPartialScan() {
      XCTAssertThrowsError(try ScannedDocument.writePDF(pageCount: 1) { _ in UIImage() })
    }
  }
#endif
