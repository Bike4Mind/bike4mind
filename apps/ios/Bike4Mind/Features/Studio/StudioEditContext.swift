import B4MKit
import SwiftUI

/// What an item needs to offer "Turn into..." and region edits. Set by Studio; absent elsewhere, which hides them.
struct StudioEditContext {
  let api: any StudioAPI
  let media: any MediaAPI
  /// The gallery's page-1 source, so the "Morph into" picker shows what the gallery already has.
  let firstPages: MediaFirstPageStore
  let tracker: GenerationTracker
  let frames: FrameUploader
  /// What the create bar already holds, so "Arrive at this" can keep an attached start frame.
  let currentInputs: @MainActor () -> [StudioInput]
  /// Hands a seed to the create bar and brings Studio to the front.
  let apply: @MainActor (StudioSeed) -> Void
  /// Brings Studio to the front, where a just-started generation's progress tile shows.
  let reveal: @MainActor () -> Void
}

extension EnvironmentValues {
  @Entry var studioEdit: StudioEditContext?
}
