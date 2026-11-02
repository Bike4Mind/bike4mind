import B4MKit
import SwiftUI

/// Signed-in navigation skeleton. Each tab owns its own stack so later milestones can push detail screens.
/// Tab selection and the Sessions stack live in `AppNavigator`, which deep links and notification taps drive.
struct MainTabView: View {
  @Environment(AppServices.self) private var services
  @Environment(\.openURL) private var openURL

  var body: some View {
    @Bindable var navigator = services.navigator
    TabView(selection: $navigator.selectedTab) {
      NavigationStack(path: $navigator.sessionPath) {
        SessionsView()
      }
      .tabItem { Label("Sessions", systemImage: "bubble.left.and.bubble.right") }
      .tag(AppTab.sessions)

      NavigationStack {
        PlaceholderScreen(
          title: "Lakes", systemImage: "drop", message: "Your data lakes will appear here.")
      }
      .tabItem { Label("Lakes", systemImage: "drop") }
      .tag(AppTab.lakes)

      NavigationStack {
        MediaGalleryView()
      }
      .tabItem { Label("Media", systemImage: "photo.on.rectangle") }
      .tag(AppTab.media)

      NavigationStack {
        SettingsView()
      }
      .tabItem { Label("Settings", systemImage: "gearshape") }
      .tag(AppTab.settings)
    }
    .sheet(
      isPresented: Binding(
        get: { navigator.newConversationRequest != nil },
        set: { if !$0 { navigator.dismissNewConversation() } })
    ) {
      NewConversationView(
        draft: navigator.newConversationRequest?.draft ?? "", api: services.api, activities: services.questActivities)
    }
    .onChange(of: navigator.externalURL) { _, url in
      guard let url else { return }
      openURL(url)
      navigator.consumeExternalURL()
    }
  }
}

struct PlaceholderScreen: View {
  let title: String
  let systemImage: String
  let message: String

  var body: some View {
    ContentUnavailableView(title, systemImage: systemImage, description: Text(message))
      .navigationTitle(title)
  }
}
