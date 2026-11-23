import Foundation
import Observation

/// Settings' voice picker: the catalog, the pick, and one sample playing at a time. Samples are the provider's
/// static preview clips, so auditioning costs no credits.
@MainActor
@Observable
public final class VoicePickerViewModel {
  /// The voice whose sample is playing, if any.
  public private(set) var playingSampleID: String?

  @ObservationIgnored private let catalog: VoiceCatalogModel
  @ObservationIgnored private let samples: any VoiceSamplePlaying
  /// Bumped per sample start and stop, so an older sample ending never clears a newer one's state.
  @ObservationIgnored private var sampleGeneration = 0

  public init(catalog: VoiceCatalogModel, samples: any VoiceSamplePlaying) {
    self.catalog = catalog
    self.samples = samples
  }

  public var voices: [VoiceOption] {
    if case .loaded(let voices) = catalog.state { voices } else { [] }
  }

  public var isLoading: Bool { catalog.state == .loading || catalog.state == .idle }

  /// The catalog could not be shown: failed to load, or the workspace has no voices.
  public var isEmpty: Bool {
    switch catalog.state {
    case .failed: true
    case .loaded(let voices): voices.isEmpty
    case .idle, .loading, .unavailable: false
    }
  }

  public var selectedID: String? { catalog.selection?.id }

  public func load() async { await catalog.load() }

  public func canPlaySample(_ voice: VoiceOption) -> Bool { voice.previewURL != nil }

  /// Picks `voice`, or on-device speech for `nil`, and stops any sample.
  public func select(_ voice: VoiceOption?) async {
    catalog.select(voice)
    await stopSample()
  }

  /// Plays `voice`'s sample, or stops it when it is the one playing. A sample that fails to load just ends.
  public func toggleSample(_ voice: VoiceOption) async {
    guard let url = voice.previewURL else { return }
    if playingSampleID == voice.id { return await stopSample() }
    sampleGeneration += 1
    let started = sampleGeneration
    await samples.stop()
    guard started == sampleGeneration else { return }
    playingSampleID = voice.id
    try? await samples.play(url)
    if started == sampleGeneration { playingSampleID = nil }
  }

  public func stopSample() async {
    sampleGeneration += 1
    playingSampleID = nil
    await samples.stop()
  }
}
