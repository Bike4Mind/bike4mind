import B4MKit
import SwiftUI
import VisionKit

/// A finished scan: the PDF plus the text read from its pages on device ("" when none was found).
struct ScannedPages {
  let url: URL
  let text: String
}

struct DocumentScanner: UIViewControllerRepresentable {
  let onFinish: (Result<ScannedPages, any Error>?) -> Void

  static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

  func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

  func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
    let controller = VNDocumentCameraViewController()
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

  @MainActor
  final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
    private let onFinish: (Result<ScannedPages, any Error>?) -> Void

    init(onFinish: @escaping (Result<ScannedPages, any Error>?) -> Void) { self.onFinish = onFinish }

    func documentCameraViewController(
      _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
    ) {
      let url: URL
      do {
        url = try ScannedDocument.writePDF(pageCount: scan.pageCount, page: scan.imageOfPage(at:))
      } catch {
        onFinish(.failure(error))
        return
      }
      let pages = (0..<scan.pageCount).compactMap { scan.imageOfPage(at: $0).cgImage }
      Task {
        let text = await ScannedDocument.recognizeText(in: pages)
        onFinish(.success(ScannedPages(url: url, text: text)))
      }
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { onFinish(nil) }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
      onFinish(.failure(error))
    }
  }
}
