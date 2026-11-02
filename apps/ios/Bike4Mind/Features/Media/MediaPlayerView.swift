import AVFoundation
import AVKit
import B4MKit
import SwiftUI

/// System player UI over `MediaPlayerConfiguration.standard`: AirPlay, picture-in-picture, and audio
/// that keeps playing with the screen locked. Failures are reported so the caller can refetch a lapsed URL.
struct MediaPlayerView: UIViewControllerRepresentable {
  let url: URL
  let configuration = MediaPlayerConfiguration.standard
  let onReady: @MainActor () -> Void
  let onFailure: @MainActor () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onReady: onReady, onFailure: onFailure)
  }

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    // Playback category is what lets audio continue in the background and PiP engage.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    let controller = AVPlayerViewController()
    controller.allowsPictureInPicturePlayback = configuration.allowsPictureInPicture
    controller.canStartPictureInPictureAutomaticallyFromInline =
      configuration.startsPictureInPictureAutomaticallyFromInline
    controller.player = configuration.makePlayer(url: url)
    context.coordinator.observe(controller.player)
    controller.player?.play()
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}

  static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
    controller.player?.pause()
    coordinator.stopObserving()
  }

  @MainActor
  final class Coordinator {
    private let onReady: @MainActor () -> Void
    private let onFailure: @MainActor () -> Void
    private var observation: NSKeyValueObservation?

    init(onReady: @escaping @MainActor () -> Void, onFailure: @escaping @MainActor () -> Void) {
      self.onReady = onReady
      self.onFailure = onFailure
    }

    func observe(_ player: AVPlayer?) {
      observation = player?.currentItem?.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
        let status = item.status
        Task { @MainActor in
          switch status {
          case .readyToPlay: self?.onReady()
          case .failed: self?.onFailure()
          default: break
          }
        }
      }
    }

    func stopObserving() {
      observation?.invalidate()
      observation = nil
    }
  }
}
