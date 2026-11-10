import B4MKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import os

/// The capture affordance for lake-oriented surfaces: take a photo, pick photos, or record a voice note, then
/// choose where to save it. The share extension reaches the same composer from other apps.
struct CaptureMenu: View {
  @Environment(AppServices.self) private var services

  private enum Flow: Identifiable {
    case camera
    case voice
    case composer([ShareItem])

    var id: String {
      switch self {
      case .camera: "camera"
      case .voice: "voice"
      case .composer: "composer"
      }
    }
  }

  @State private var flow: Flow?
  @State private var isPickingPhotos = false
  @State private var pickedPhotos: [PhotosPickerItem] = []
  @State private var problem: String?
  /// Items that did load when some did not: the composer opens once the notice about the rest is dismissed.
  @State private var afterProblem: [ShareItem]?

  var body: some View {
    Menu {
      if CameraPicker.isAvailable {
        Button("Take Photo", systemImage: "camera") { flow = .camera }
          .accessibilityIdentifier("capture-camera-btn")
      }
      Button("Choose Photos", systemImage: "photo.on.rectangle") { isPickingPhotos = true }
        .accessibilityIdentifier("capture-photos-btn")
      Button("Voice Note", systemImage: "mic") { flow = .voice }
        .accessibilityIdentifier("capture-voice-btn")
    } label: {
      Label("Capture", systemImage: "plus.viewfinder")
    }
    .accessibilityLabel("Capture")
    .accessibilityIdentifier("capture-menu")
    .photosPicker(isPresented: $isPickingPhotos, selection: $pickedPhotos, maxSelectionCount: 10, matching: .images)
    .onChange(of: pickedPhotos) { _, picked in
      guard !picked.isEmpty else { return }
      pickedPhotos = []
      Task { await load(picked) }
    }
    .fullScreenCover(item: cameraBinding) { _ in
      CameraPicker { url in
        flow = nil
        guard let url else { return }
        Task { await present(files: [url]) }
      }
      .ignoresSafeArea()
    }
    .sheet(item: sheetBinding) { current in
      switch current {
      case .voice:
        VoiceRecorderPanel(
          onTranscript: { text in flow = .composer([.text(text)]) },
          onCancel: { flow = nil })
      case .composer(let items):
        ShareComposerView(
          model: services.capture.composerModel(items: items), onFinish: { flow = nil }, onCancel: { flow = nil })
      case .camera:
        EmptyView()
      }
    }
    .alert(
      afterProblem == nil ? "Couldn't use that" : "Some photos were skipped",
      isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })
    ) {
      Button("OK", role: .cancel) {
        guard let items = afterProblem else { return }
        afterProblem = nil
        flow = .composer(items)
      }
    } message: {
      Text(problem ?? "")
    }
  }

  private var cameraBinding: Binding<Flow?> {
    Binding(get: { if case .camera = flow { flow } else { nil } }, set: { if $0 == nil { flow = nil } })
  }

  private var sheetBinding: Binding<Flow?> {
    Binding(get: { if case .camera = flow { nil } else { flow } }, set: { if $0 == nil { flow = nil } })
  }

  private func load(_ picked: [PhotosPickerItem]) async {
    var urls: [URL] = []
    var failed = 0
    for item in picked {
      do {
        if let file = try await item.loadTransferable(type: PickedImageFile.self) {
          urls.append(file.url)
        } else {
          failed += 1
        }
      } catch {
        failed += 1
        Self.logger.error("Picked photo could not be loaded: \(String(describing: error), privacy: .public)")
      }
    }
    await present(files: urls, alreadyFailed: failed)
  }

  private func present(files: [URL], alreadyFailed: Int = 0) async {
    let sources = files.map { LocalFileAttachment(fileURL: $0, type: Self.type(of: $0)) }
    let loaded = await ShareItemLoader().load(sources)
    let failed = alreadyFailed + loaded.skippedCount
    guard !loaded.items.isEmpty else {
      afterProblem = nil
      problem = "None of the selected photos could be read."
      return
    }
    guard failed == 0 else {
      afterProblem = loaded.items
      problem =
        failed == 1
        ? "1 photo couldn't be read. The rest are ready to save."
        : "\(failed) photos couldn't be read. The rest are ready to save."
      return
    }
    flow = .composer(loaded.items)
  }

  private static let logger = Logger(subsystem: "com.bike4mind.app", category: "capture")

  private static func type(of url: URL) -> UTType {
    UTType(filenameExtension: url.pathExtension) ?? .image
  }
}

/// A picked photo copied out of the picker's short-lived location.
private struct PickedImageFile: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      let directory = FileManager.default.temporaryDirectory.appending(path: "picked-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let copy = directory.appending(path: received.file.lastPathComponent)
      try FileManager.default.copyItem(at: received.file, to: copy)
      return PickedImageFile(url: copy)
    }
  }
}
