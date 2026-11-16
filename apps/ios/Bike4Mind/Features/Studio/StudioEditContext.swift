import B4MKit
import SwiftUI

/// What an item needs to offer "Turn into..." and region edits. Set by Studio; absent elsewhere, which hides them.
struct StudioEditContext {
  let api: any StudioAPI
  let media: any MediaAPI
  let tracker: GenerationTracker
  let frames: FrameUploader
  /// What the create bar already holds, so "Arrive at this" can keep an attached start frame.
  let currentInputs: @MainActor () -> [StudioInput]
  /// Hands a seed to the create bar and brings Studio to the front.
  let apply: @MainActor (StudioSeed) -> Void
}

extension EnvironmentValues {
  @Entry var studioEdit: StudioEditContext?
}
