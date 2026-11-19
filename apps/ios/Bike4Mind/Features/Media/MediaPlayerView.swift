import AVFoundation
import AVKit
import B4MKit
import SwiftUI
import os

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
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    } catch {
      // Playback still works in the foreground; only background audio and PiP are lost.
      Self.logger.error("Playback audio session category failed: \(String(describing: error), privacy: .public)")
    }
    let controller = AVPlayerViewController()
    controller.allowsPictureInPicturePlayback = configuration.allowsPictureInPicture
    controller.canStartPictureInPictureAutomaticallyFromInline =
      configuration.startsPictureInPictureAutomaticallyFromInline
    controller.player = configuration.makePlayer(url: url)
    context.coordinator.attach(to: controller, url: url)
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}

  static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
    controller.player?.pause()
    coordinator.stopObserving()
  }

  fileprivate static let logger = Logger(subsystem: "com.bike4mind.app", category: "media")

  @MainActor
  final class Coordinator {
    private let onReady: @MainActor () -> Void
    private let onFailure: @MainActor () -> Void
    private var observations: [NSKeyValueObservation] = []
    private weak var player: AVPlayer?
    private var hasStarted = false
    private var poster: PosterOverlay?
    private var posterTask: Task<Void, Never>?

    init(onReady: @escaping @MainActor () -> Void, onFailure: @escaping @MainActor () -> Void) {
      self.onReady = onReady
      self.onFailure = onFailure
    }

    func attach(to controller: AVPlayerViewController, url: URL) {
      guard let player = controller.player, let item = player.currentItem else { return }
      self.player = player
      showPoster(in: controller, url: url)
      observations = [
        item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
          let status = item.status
          let error = item.error.map { String(describing: $0) } ?? "none"
          Task { @MainActor in self?.itemStatusChanged(status, error: error) }
        },
        player.observe(\.timeControlStatus, options: [.initial, .new]) { player, _ in
          let status = player.timeControlStatus.rawValue
          let reason = player.reasonForWaitingToPlay?.rawValue ?? "none"
          let rate = player.rate
          MediaPlayerView.logger.info(
            "Player timeControlStatus=\(status, privacy: .public) waiting=\(reason, privacy: .public) rate=\(rate, privacy: .public)"
          )
        },
        controller.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] controller, _ in
          guard controller.isReadyForDisplay else { return }
          Task { @MainActor in self?.hidePoster() }
        },
      ]
    }

    func stopObserving() {
      observations.forEach { $0.invalidate() }
      observations = []
      posterTask?.cancel()
      posterTask = nil
    }

    private func itemStatusChanged(_ status: AVPlayerItem.Status, error: String) {
      MediaPlayerView.logger.info(
        "Player item status=\(status.rawValue, privacy: .public) error=\(error, privacy: .public)")
      switch status {
      case .readyToPlay:
        // Start from readiness rather than at creation: a play() issued before the item is ready can be
        // undone by AVKit during the push, or wait indefinitely to minimize stalls on a slow stream.
        // Only once, so a later ready (after a seek) never overrides a pause the user chose.
        if !hasStarted {
          hasStarted = true
          player?.playImmediately(atRate: 1)
        }
        onReady()
      case .failed:
        hidePoster()
        onFailure()
      default:
        break
      }
    }

    /// The first frame (or a spinner until it decodes) over the video area, so the player is never a
    /// bare black rectangle while it buffers. Removed once AVKit has a frame of its own to show.
    private func showPoster(in controller: AVPlayerViewController, url: URL) {
      guard let container = controller.contentOverlayView else { return }
      let overlay = PosterOverlay()
      overlay.frame = container.bounds
      overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      container.addSubview(overlay)
      poster = overlay
      posterTask = Task { [weak self] in
        guard let frame = await Self.firstFrame(of: url), !Task.isCancelled else { return }
        self?.poster?.show(UIImage(cgImage: frame))
      }
    }

    /// Its own asset rather than the player's: an asset is not Sendable, so the player's cannot be
    /// handed to the generator off the main actor.
    private nonisolated static func firstFrame(of url: URL) async -> CGImage? {
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 1280, height: 1280)
      return try? await generator.image(at: .zero).image
    }

    private func hidePoster() {
      posterTask?.cancel()
      posterTask = nil
      poster?.removeFromSuperview()
      poster = nil
    }
  }
}

private final class PosterOverlay: UIView {
  private let imageView = UIImageView()
  private let spinner = UIActivityIndicatorView(style: .large)

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isUserInteractionEnabled = false
    imageView.contentMode = .scaleAspectFit
    imageView.frame = bounds
    imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(imageView)
    spinner.color = .white
    spinner.translatesAutoresizingMaskIntoConstraints = false
    addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    spinner.startAnimating()
    accessibilityIdentifier = "media-player-poster"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func show(_ image: UIImage) {
    imageView.image = image
  }
}
