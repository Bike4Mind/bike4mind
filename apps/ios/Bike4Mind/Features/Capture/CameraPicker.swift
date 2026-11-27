import SwiftUI
import UIKit

/// The system camera. Hands back a JPEG written to a temporary file, or `nil` when cancelled.
struct CameraPicker: UIViewControllerRepresentable {
  let onFinish: (URL?) -> Void

  static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

  func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let onFinish: (URL?) -> Void

    init(onFinish: @escaping (URL?) -> Void) { self.onFinish = onFinish }

    func imagePickerController(
      _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85) else {
        return onFinish(nil)
      }
      let location = FileManager.default.temporaryDirectory.appending(path: "Photo-\(UUID().uuidString).jpg")
      do {
        try data.write(to: location)
        onFinish(location)
      } catch {
        onFinish(nil)
      }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onFinish(nil) }
  }
}
