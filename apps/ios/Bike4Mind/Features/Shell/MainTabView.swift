import B4MKit
import SwiftUI

/// Signed-in navigation skeleton. Each tab owns its own stack so later milestones can push detail screens.
/// Tab selection and the Sessions stack live in `AppNavigator`, which deep links and notification taps drive.
struct MainTabView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    @Bindable var navigator = services.navigator
    TabView(selection: $navigator.selectedTab) {
      NavigationStack(path: $navigator.sessionPath) {
        SessionsView()
      }
      .tabItem { Label("Sessions", systemImage: "bubble.left.and.bubble.right") }
      .tag(AppTab.sessions)

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
    // Keyed on the request, so a second Siri request while the sheet is up replaces the draft instead of
    // being dropped.
    .sheet(
      item: Binding(
        get: { navigator.newConversationRequest.map(NewConversationSheet.init) },
        set: { if $0 == nil { navigator.dismissNewConversation() } })
    ) { sheet in
      NewConversationView(draft: sheet.request.draft, api: services.api, activities: services.questActivities)
    }
    .inAppSafari(
      url: Binding(
        get: { navigator.externalURL },
        set: { if $0 == nil { navigator.consumeExternalURL() } }))
  }
}

private struct NewConversationSheet: Identifiable {
  let request: ComposeRequest
  var id: ComposeRequest { request }
}
