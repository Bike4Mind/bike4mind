import B4MKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import os

/// The capture affordance for lake-oriented surfaces: take a photo, pick photos, or record a voice note, then
/// choose where to save it. The share extension reaches the same composer from other apps. A dictated follow-up
/// memo instead becomes a brief of proposed action items, a draft email and reminders.
struct CaptureMenu: View {
  @Environment(AppServices.self) private var services

  private enum Flow: Identifiable {
    case camera(ask: Bool)
    case scanner
    case voice
    case followUp
    case followUpBrief(String)
    case composer([ShareItem], ask: Bool = false)
    case handoff(ObligationHandoffModel)

    var id: String {
      switch self {
      case .camera: "camera"
      case .scanner: "scanner"
      case .voice: "voice"
      case .followUp: "followUp"
      case .followUpBrief(let id): "followUpBrief-\(id)"
      case .composer: "composer"
      case .handoff: "handoff"
      }
    }
  }

  @State private var flow: Flow?
  @State private var isPickingPhotos = false
  @State private var pickedPhotos: [PhotosPickerItem] = []
  @State private var problem: String?
  @State private var pendingCapture: (url: URL, ask: Bool)?
  @State private var pendingScan: ScannedPages?
  /// A finished scan waiting on the choice between the normal composer and handing it to the assistant.
  @State private var offeredScan: ScannedPages?
  /// Items that did load when some did not: the composer opens once the notice about the rest is dismissed.
  @State private var afterProblem: [ShareItem]?
  @State private var isSendingFollowUp = false

  var body: some View {
    Menu {
      if CameraPicker.isAvailable {
        Button("Point and Ask", systemImage: "camera.viewfinder") { flow = .camera(ask: true) }
          .accessibilityIdentifier("capture-ask-btn")
        Button("Take Photo", systemImage: "camera") { flow = .camera(ask: false) }
          .accessibilityIdentifier("capture-camera-btn")
      }
      Button("Scan Document", systemImage: "doc.viewfinder") { flow = .scanner }
        .disabled(!DocumentScanner.isAvailable)
        .accessibilityIdentifier("capture-scan-btn")
      Button("Choose Photos", systemImage: "photo.on.rectangle") { isPickingPhotos = true }
        .accessibilityIdentifier("capture-photos-btn")
      Button("Voice Note", systemImage: "mic") { flow = .voice }
        .accessibilityIdentifier("capture-voice-btn")
      Button("Follow-up", systemImage: "mic.badge.plus") { flow = .followUp }
        .disabled(isSendingFollowUp)
        .accessibilityIdentifier("capture-followup-btn")
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
    .fullScreenCover(item: cameraBinding, onDismiss: completeCapture) { current in
      Group {
        if case .scanner = current {
          DocumentScanner { result in
            flow = nil
            switch result {
            case .success(let scan): pendingScan = scan
            case .failure: problem = "The scan couldn't be saved. Please try again."
            case nil: break
            }
          }
        } else if case .camera(let ask) = current {
          CameraPicker { url in
            flow = nil
            if let url { pendingCapture = (url, ask) }
          }
        }
      }
      .ignoresSafeArea()
    }
    .sheet(item: sheetBinding) { current in
      switch current {
      case .voice:
        VoiceRecorderPanel(
          onTranscript: { text in flow = .composer([.text(text)]) },
          onCancel: { flow = nil })
      case .followUp:
        VoiceRecorderPanel(onTranscript: sendFollowUp, onCancel: { flow = nil })
      case .followUpBrief(let id):
        NavigationStack {
          BriefView(briefID: id)
            .toolbar {
              ToolbarItem(placement: .cancellationAction) {
                Button("Done") { flow = nil }
                  .accessibilityIdentifier("capture-followup-done-btn")
              }
            }
        }
      case .composer(let items, let ask):
        ShareComposerView(
          model: services.capture.composerModel(items: items), onFinish: { flow = nil }, onCancel: { flow = nil },
          asksQuestion: ask)
      case .handoff(let model):
        ObligationConfirmSheet(model: model, onClose: { flow = nil })
      case .camera, .scanner:
        EmptyView()
      }
    }
    .confirmationDialog(
      "Use this scan", isPresented: Binding(get: { offeredScan != nil }, set: { if !$0 { offeredScan = nil } }),
      presenting: offeredScan
    ) { scan in
      Button("Hand to assistant") {
        flow = .handoff(services.obligationHandoffModel(file: scan.url, text: scan.text))
      }
      .accessibilityIdentifier("capture-handoff-btn")
      Button("Save or send") { Task { await present(files: [scan.url]) } }
        .accessibilityIdentifier("capture-scan-compose-btn")
    } message: { _ in
      Text("Hand a bill or letter to the assistant to track what's owed and when.")
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
    Binding(
      get: {
        switch flow {
        case .camera, .scanner: flow
        default: nil
        }
      }, set: { if $0 == nil { flow = nil } })
  }

  private var sheetBinding: Binding<Flow?> {
    Binding(
      get: {
        switch flow {
        case .camera, .scanner: nil
        default: flow
        }
      }, set: { if $0 == nil { flow = nil } })
  }

  private func sendFollowUp(_ transcript: String) {
    let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    flow = nil
    guard !trimmed.isEmpty else {
      problem = "Nothing was heard. Please try again."
      return
    }
    isSendingFollowUp = true
    Task {
      defer { isSendingFollowUp = false }
      do {
        let brief = try await services.briefFollowUps.followUp(
          transcript: String(trimmed.prefix(Self.maxFollowUpTranscript)), timeZone: TimeZone.current.identifier)
        // A sheet opened while the memo was sending keeps what the user typed; the brief_ready push still opens it.
        if case .none = flow { flow = .followUpBrief(brief.id) }
      } catch {
        Self.logger.error("Follow-up memo was not accepted: \(String(describing: error), privacy: .public)")
        afterProblem = nil
        problem = "The follow-up couldn't be sent. Please try again."
      }
    }
  }

  // Must match BRIEF_LIMITS.followUpTranscript in b4m-core/common/src/schemas/brief.ts.
  private static let maxFollowUpTranscript = 6000

  private func completeCapture() {
    if let scan = pendingScan {
      pendingScan = nil
      offeredScan = scan
      return
    }
    guard let capture = pendingCapture else { return }
    pendingCapture = nil
    Task { await present(files: [capture.url], ask: capture.ask) }
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

  private func present(files: [URL], alreadyFailed: Int = 0, ask: Bool = false) async {
    let sources = files.map { LocalFileAttachment(fileURL: $0, type: Self.type(of: $0)) }
    let loaded = await ShareItemLoader().load(sources)
    let failed = alreadyFailed + loaded.skippedCount
    guard !loaded.items.isEmpty else {
      afterProblem = nil
      problem = "The capture couldn't be read. Please try again."
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
    flow = .composer(loaded.items, ask: ask)
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
