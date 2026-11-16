import Foundation
import Observation

/// Drives "Share" and "Save" on one gallery item: prepares the local file, hands it to the destination, and
/// reports the result in words a person can read.
@MainActor
@Observable
public final class MediaExportViewModel {
  public enum State: Equatable {
    case idle
    case preparing(MediaDestination)
    /// A file ready for the share sheet or the Files mover.
    case ready(MediaDestination, URL)
    case finished(String)
    case failed(String)
  }

  public private(set) var state: State = .idle

  @ObservationIgnored private let exporter: MediaExporter
  @ObservationIgnored private let saveToPhotos: @Sendable (URL, MediaKind) async throws -> Void

  public init(exporter: MediaExporter, saveToPhotos: @escaping @Sendable (URL, MediaKind) async throws -> Void) {
    self.exporter = exporter
    self.saveToPhotos = saveToPhotos
  }

  public var isBusy: Bool {
    if case .preparing = state { return true }
    return false
  }

  public func start(_ destination: MediaDestination, item: MediaItem) async {
    guard !isBusy else { return }
    if destination == .photos, !MediaDestination.canSaveToPhotos(item.kind) {
      state = .failed("Audio can't be saved to Photos. Use Save to Files or Share instead.")
      return
    }
    state = .preparing(destination)
    do {
      let file = try await exporter.export(item)
      switch destination {
      case .share, .files:
        state = .ready(destination, file)
      case .photos:
        try await saveToPhotos(file, item.kind)
        state = .finished(item.kind == .video ? "Video saved to Photos." : "Image saved to Photos.")
      }
    } catch is CancellationError {
      state = .idle
    } catch {
      state = .failed(Self.message(for: error))
    }
  }

  /// Clears a finished, failed or consumed state so the same action can run again.
  public func reset() { state = .idle }

  public func completeFiles() { state = .finished("Saved to Files.") }

  static func message(for error: any Error) -> String {
    switch error {
    case MediaExportError.notAvailable: "This file is still being processed. Try again in a moment."
    case MediaExportError.api(.offline): "You appear to be offline. Check your connection and try again."
    case MediaExportError.api(.signedOut): "Your session has ended. Sign in again to continue."
    case let denied as PhotosSaveError: denied.message
    default: "Couldn't prepare this file. Please try again."
    }
  }
}

/// Why the Photos library refused a save.
public enum PhotosSaveError: Error, Equatable, Sendable {
  case denied
  case failed

  public var message: String {
    switch self {
    case .denied: "Allow Bike4Mind to add to your photos in Settings, then try again."
    case .failed: "Couldn't save to Photos. Please try again."
    }
  }
}
