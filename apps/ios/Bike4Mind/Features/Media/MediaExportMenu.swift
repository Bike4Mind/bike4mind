import B4MKit
import Observation
import Photos
import SwiftUI
import UIKit

extension MediaExporter {
  /// Downloads through the shared session; a non-2xx answer is a failure, not a file.
  static func live(api: any MediaAPI) -> MediaExporter {
    MediaExporter(
      api: api,
      download: { url in
        let (file, response) = try await URLSession.shared.download(from: url)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
          throw APIError.malformedResponse
        }
        return file
      })
  }
}

/// Adds a downloaded file to the Photos library with the type its bytes are (image or video). Needs only the
/// add-only permission, so the app never reads the library.
enum PhotosSaver {
  static func save(_ file: URL, kind: MediaKind) async throws {
    guard PHPhotoLibrary.authorizationStatus(for: .addOnly) != .denied else { throw PhotosSaveError.denied }
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized || status == .limited else { throw PhotosSaveError.denied }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        let request = PHAssetCreationRequest.forAsset()
        request.addResource(with: kind == .video ? .video : .photo, fileURL: file, options: nil)
      }
    } catch {
      throw PhotosSaveError.failed
    }
  }
}

/// The system share sheet for one local file.
private struct ActivitySheet: UIViewControllerRepresentable {
  let file: URL

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [file], applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Share and Save for gallery items, shared by the detail toolbar and the gallery's context menu. The bytes are
/// downloaded first, so what leaves the app is the media itself rather than a link that lapses.
@MainActor
@Observable
final class MediaExportPresenter {
  fileprivate var sharing: URL?
  fileprivate var moving: URL?
  var message: String?
  private(set) var isBusy = false
  private let model: MediaExportViewModel

  init(media: any MediaAPI) {
    model = MediaExportViewModel(
      exporter: .live(api: media), saveToPhotos: { file, kind in try await PhotosSaver.save(file, kind: kind) })
  }

  func start(_ destination: MediaDestination, item: MediaItem) {
    guard !isBusy else { return }
    isBusy = true
    Task {
      await model.start(destination, item: item)
      isBusy = false
      switch model.state {
      case .ready(.share, let file): sharing = file
      case .ready(.files, let file): moving = file
      case .finished(let text), .failed(let text): message = text
      default: break
      }
      model.reset()
    }
  }
}

private struct IdentifiedURL: Identifiable {
  let url: URL
  var id: URL { url }
}

extension View {
  /// Presents the share sheet, Files mover and result alert for `presenter`.
  func mediaExport(_ presenter: MediaExportPresenter) -> some View {
    modifier(MediaExportPresentation(presenter: presenter))
  }
}

private struct MediaExportPresentation: ViewModifier {
  @Bindable var presenter: MediaExportPresenter

  func body(content: Content) -> some View {
    content
      .sheet(
        item: Binding(
          get: { presenter.sharing.map(IdentifiedURL.init) }, set: { if $0 == nil { presenter.sharing = nil } })
      ) { ActivitySheet(file: $0.url).presentationDetents([.medium, .large]) }
      .fileMover(
        isPresented: Binding(get: { presenter.moving != nil }, set: { if !$0 { presenter.moving = nil } }),
        file: presenter.moving
      ) { result in
        if case .success = result { presenter.message = "Saved to Files." }
        presenter.moving = nil
      }
      .alert(
        "Media", isPresented: Binding(get: { presenter.message != nil }, set: { if !$0 { presenter.message = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(presenter.message ?? "")
      }
  }
}

/// The Share / Save menu entries for one item.
struct MediaExportButtons: View {
  let item: MediaItem
  let presenter: MediaExportPresenter

  var body: some View {
    Button("Share", systemImage: "square.and.arrow.up") { presenter.start(.share, item: item) }
      .accessibilityIdentifier("media-share-btn")
    if MediaDestination.canSaveToPhotos(item.kind) {
      Button("Save to Photos", systemImage: "square.and.arrow.down") { presenter.start(.photos, item: item) }
        .accessibilityIdentifier("media-save-photos-btn")
    }
    Button("Save to Files", systemImage: "folder") { presenter.start(.files, item: item) }
      .accessibilityIdentifier("media-save-files-btn")
  }
}
