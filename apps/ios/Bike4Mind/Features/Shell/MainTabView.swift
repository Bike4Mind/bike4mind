import B4MKit
import SwiftUI

/// Signed-in navigation skeleton. Each tab owns its own stack so later milestones can push detail screens.
/// Tab selection and the Chat stack live in `AppNavigator`, which deep links and notification taps drive.
struct MainTabView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    @Bindable var navigator = services.navigator
    TabView(selection: $navigator.selectedTab) {
      NavigationStack(path: $navigator.sessionPath) {
        NewConversationView(api: services.api, activities: services.questActivities)
          .navigationDestination(for: SessionsDestination.self) { destination in
            switch destination {
            case .sessionList:
              SessionsView()
            case .session(let session):
              SessionDetailView(session: session)
                // Conversations are full-bleed so the composer sits at the bottom edge; Back brings the bar back.
                .toolbar(.hidden, for: .tabBar)
                // Opening a conversation is the first moment the app has shown the user value, so this is
                // when the one-time system notification prompt appears.
                .task { await services.push.userDidReachValueMoment() }
            case .settings:
              SettingsView()
            }
          }
      }
      .tabItem { Label("Chat", systemImage: "bubble.left") }
      .tag(AppTab.sessions)

      NavigationStack {
        MediaGalleryView()
      }
      .tabItem { Label("Media", systemImage: "photo.on.rectangle") }
      .tag(AppTab.media)
    }
    .inAppSafari(
      url: Binding(
        get: { navigator.externalURL },
        set: { if $0 == nil { navigator.consumeExternalURL() } }))
  }
}
