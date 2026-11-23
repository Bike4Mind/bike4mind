import Foundation

/// Speaks reply chunks in a premium server voice, falling back to `fallback` (on-device speech) on any failure.
/// The first failure latches: the rest of the conversation stays on the fallback, so the voice never flips back
/// and forth and no later chunk waits on a call that is likely to fail too. Nothing is surfaced to the user.
@MainActor
public final class ServerSpeechSpeaker: SpeechSpeaking, SpeechPrefetching {
  /// At most this many clips are fetched ahead of the one playing; later chunks wait their turn in `queued`.
  public static let prefetchLimit = 2

  public private(set) var isDegraded = false

  private let wire: any VoiceAPI
  private let voiceID: String
  private let fallback: any SpeechSpeaking
  private let player: any AudioClipPlaying
  private var prefetched: [(text: String, clip: Task<Data, any Error>)] = []
  private var queued: [String] = []
  private var current: Task<Data, any Error>?
  /// Bumped by `stop()`, so a clip that arrives after it is never played.
  private var generation = 0

  public init(wire: any VoiceAPI, voiceID: String, fallback: any SpeechSpeaking, player: any AudioClipPlaying) {
    self.wire = wire
    self.voiceID = voiceID
    self.fallback = fallback
    self.player = player
  }

  public func prepare(_ text: String) {
    guard !isDegraded, !prefetched.contains(where: { $0.text == text }), !queued.contains(text) else { return }
    queued.append(text)
    refill()
  }

  public func speak(_ text: String) async {
    guard !isDegraded else { return await fallback.speak(text) }
    let started = generation
    let clip: Task<Data, any Error>
    if let index = prefetched.firstIndex(where: { $0.text == text }) {
      clip = prefetched.remove(at: index).clip
    } else {
      queued.removeAll { $0 == text }
      clip = fetch(text)
    }
    current = clip
    refill()
    do {
      let data = try await clip.value
      guard started == generation else { return }
      try await player.play(data)
    } catch {
      guard started == generation else { return }
      degrade()
      await fallback.speak(text)
    }
  }

  public func stop() async {
    generation += 1
    cancelFetches()
    await player.stop()
    await fallback.stop()
  }

  private func fetch(_ text: String) -> Task<Data, any Error> {
    Task { [wire, voiceID] in try await wire.synthesizeSpeech(text: text, voiceID: voiceID) }
  }

  private func refill() {
    while prefetched.count < Self.prefetchLimit, !queued.isEmpty {
      let text = queued.removeFirst()
      prefetched.append((text, fetch(text)))
    }
  }

  private func degrade() {
    isDegraded = true
    cancelFetches()
  }

  private func cancelFetches() {
    current?.cancel()
    current = nil
    for entry in prefetched { entry.clip.cancel() }
    prefetched = []
    queued = []
  }
}
