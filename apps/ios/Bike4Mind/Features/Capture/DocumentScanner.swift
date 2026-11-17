import B4MKit
import SwiftUI
import VisionKit

struct DocumentScanner: UIViewControllerRepresentable {
  let onFinish: (Result<URL, any Error>?) -> Void

  static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

  func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

  func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
    let controller = VNDocumentCameraViewController()
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

  final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
    private let onFinish: (Result<URL, any Error>?) -> Void

    init(onFinish: @escaping (Result<URL, any Error>?) -> Void) { self.onFinish = onFinish }

    func documentCameraViewController(
      _ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
    ) {
      onFinish(Result { try ScannedDocument.writePDF(pageCount: scan.pageCount, page: scan.imageOfPage(at:)) })
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { onFinish(nil) }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: any Error) {
      onFinish(.failure(error))
    }
  }
}
