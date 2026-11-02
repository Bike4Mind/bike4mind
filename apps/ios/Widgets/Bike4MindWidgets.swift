import SwiftUI
import WidgetKit

/// Entry point of the widget extension.
///
/// M5 (Live Activities): add the `ActivityConfiguration` widget to `body` below, next to the home-screen
/// widgets. A Live Activity's UI must live in a widget extension, and this is the only one. Reuse
/// `Shared/` (snapshot loading, deep-link destinations, background styling) for its views, and put the
/// `ActivityAttributes` type in a file both the app and this target compile (B4MKit, or a synchronized-folder
/// membership exception), since the app starts and updates the activity.
@main
struct Bike4MindWidgets: WidgetBundle {
  var body: some Widget {
    RunningAgentsWidget()
    CreditsWidget()
    LatestGenerationWidget()
    // M5: QuestLiveActivity()
  }
}
