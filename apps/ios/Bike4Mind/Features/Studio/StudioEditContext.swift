import B4MKit
import SwiftUI

/// What an image detail needs to offer region edits. Set by Studio; absent elsewhere, which hides the Edit button.
struct StudioEditContext {
  let api: any StudioAPI
  let media: any MediaAPI
  let tracker: GenerationTracker
}

extension EnvironmentValues {
  @Entry var studioEdit: StudioEditContext?
}
