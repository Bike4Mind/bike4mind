import SwiftUI
import WidgetKit

/// Entry point of the widget extension: the home-screen widgets and the quest Live Activity.
@main
struct Bike4MindWidgets: WidgetBundle {
  var body: some Widget {
    RunningAgentsWidget()
    CreditsWidget()
    LatestGenerationWidget()
    QuestLiveActivity()
  }
}
