import AVFoundation
import Foundation

/// How media playback is set up. The flags are data so the policy is testable; the app's player view
/// applies them to the `AVPlayerViewController` (`allowsPictureInPicturePlayback`) it hosts.
public struct MediaPlayerConfiguration: Equatable, Sendable {
  public var allowsExternalPlayback: Bool
  /// Keep playing on the TV while the phone's own screen is mirrored.
  public var usesExternalPlaybackWhileExternalScreenIsActive: Bool
  public var allowsPictureInPicture: Bool
  public var startsPictureInPictureAutomaticallyFromInline: Bool
  /// Audio keeps playing with the screen locked or the app in the background.
  public var continuesPlaybackInBackground: Bool

  public static let standard = MediaPlayerConfiguration(
    allowsExternalPlayback: true,
    usesExternalPlaybackWhileExternalScreenIsActive: true,
    allowsPictureInPicture: true,
    startsPictureInPictureAutomaticallyFromInline: true,
    continuesPlaybackInBackground: true)

  @MainActor
  public func makePlayer(url: URL) -> AVPlayer {
    let item = AVPlayerItem(url: url)
    let player = AVPlayer(playerItem: item)
    #if os(iOS)
      player.audiovisualBackgroundPlaybackPolicy = continuesPlaybackInBackground ? .continuesIfPossible : .automatic
    #endif
    player.allowsExternalPlayback = allowsExternalPlayback
    #if os(iOS)
      player.usesExternalPlaybackWhileExternalScreenIsActive = usesExternalPlaybackWhileExternalScreenIsActive
    #endif
    return player
  }
}
