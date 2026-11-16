import B4MKit
import PhotosUI
import SwiftUI
import UIKit

/// "Make something from a photo": take or choose a photo, upload it, then either animate it into a video or edit
/// it. The photo is just another Studio input, so everything after the upload is the existing create flow.
struct StudioPhotoButton: View {
  let context: StudioEditContext

  private enum Phase: Equatable {
    case idle
    case uploading
    case choosing(MediaItem)
  }

  @State private var phase: Phase = .idle
  @State private var isPickingPhoto = false
  @State private var isTakingPhoto = false
  @State private var pickedPhoto: PhotosPickerItem?
  @State private var editing: MediaItem?
  @State private var problem: String?

  var body: some View {
    Group {
      if phase == .uploading {
        ProgressView().frame(minWidth: 44, minHeight: 44)
      } else {
        Menu {
          if CameraPicker.isAvailable {
            Button("Take Photo", systemImage: "camera") { isTakingPhoto = true }
              .accessibilityIdentifier("studio-photo-camera-btn")
          }
          Button("Choose Photo", systemImage: "photo.on.rectangle") { isPickingPhoto = true }
            .accessibilityIdentifier("studio-photo-library-btn")
        } label: {
          Image(systemName: "photo.badge.plus").frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("Start from a photo")
        .accessibilityIdentifier("studio-photo-menu")
      }
    }
    .photosPicker(isPresented: $isPickingPhoto, selection: $pickedPhoto, matching: .images)
    .onChange(of: pickedPhoto) { _, picked in
      guard let picked else { return }
      pickedPhoto = nil
      Task { await upload { try await Self.jpeg(from: picked) } }
    }
    .fullScreenCover(isPresented: $isTakingPhoto) {
      CameraPicker { url in
        isTakingPhoto = false
        guard let url else { return }
        Task { await upload { try Data(contentsOf: url) } }
      }
      .ignoresSafeArea()
    }
    .confirmationDialog(
      "What should it become?", isPresented: Binding(get: { chosen != nil }, set: { if !$0 { phase = .idle } }),
      titleVisibility: .visible
    ) {
      if let photo = chosen {
        Button("Animate it into a video") {
          phase = .idle
          context.apply(StudioSeed(kind: .video, prompt: "", inputs: [StudioInput(role: .firstFrame, item: photo)]))
        }
        .accessibilityIdentifier("studio-photo-animate")
        Button("Edit it with a prompt") {
          phase = .idle
          editing = photo
        }
        .accessibilityIdentifier("studio-photo-edit")
      }
    }
    .fullScreenCover(item: $editing) { photo in
      RegionEditView(item: photo, api: context.api, media: context.media, tracker: context.tracker)
    }
    .alert(
      "Couldn't use that photo", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(problem ?? "")
    }
  }

  private var chosen: MediaItem? {
    if case .choosing(let item) = phase { item } else { nil }
  }

  private func upload(_ load: () async throws -> Data) async {
    phase = .uploading
    do {
      let data = try await load()
      let item = try await context.frames.upload(jpeg: data, fileName: "Photo-\(UUID().uuidString.prefix(8)).jpg")
      phase = .choosing(item)
    } catch let error as FrameUploadError {
      phase = .idle
      problem = Self.message(for: error)
    } catch {
      phase = .idle
      problem = "The photo couldn't be loaded. Please try another."
    }
  }

  static func message(for error: FrameUploadError) -> String {
    switch error {
    case .blocked: "This photo was blocked by the safety scan and can't be used."
    case .notReady: "The photo is still being checked. Try again in a moment."
    case .api(.offline): "You appear to be offline. Check your connection and try again."
    case .api: "The upload failed. Please try again."
    }
  }

  /// Decodes whatever the picker hands back (HEIC included) and re-encodes a JPEG bounded to what the models take.
  private static func jpeg(from item: PhotosPickerItem, maxDimension: CGFloat = 2048) async throws -> Data {
    guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let longest = max(image.size.width, image.size.height)
    let scale = min(1, maxDimension / longest)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
    guard let jpeg = resized.jpegData(compressionQuality: 0.85) else { throw CocoaError(.fileWriteUnknown) }
    return jpeg
  }
}
