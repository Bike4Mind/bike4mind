import SwiftUI

/// Signed-in navigation skeleton. Each tab owns its own stack so later milestones can push detail screens.
struct MainTabView: View {
  enum Tab: Hashable {
    case sessions, lakes, media, settings
  }

  @State private var selection: Tab = .sessions

  var body: some View {
    TabView(selection: $selection) {
      NavigationStack {
        PlaceholderScreen(
          title: "Sessions", systemImage: "bubble.left.and.bubble.right",
          message: "Your chat sessions will appear here.")
      }
      .tabItem { Label("Sessions", systemImage: "bubble.left.and.bubble.right") }
      .tag(Tab.sessions)

      NavigationStack {
        PlaceholderScreen(
          title: "Lakes", systemImage: "drop", message: "Your data lakes will appear here.")
      }
      .tabItem { Label("Lakes", systemImage: "drop") }
      .tag(Tab.lakes)

      NavigationStack {
        PlaceholderScreen(
          title: "Media", systemImage: "photo.on.rectangle",
          message: "Your generated images, video and music will appear here.")
      }
      .tabItem { Label("Media", systemImage: "photo.on.rectangle") }
      .tag(Tab.media)

      NavigationStack {
        SettingsView()
      }
      .tabItem { Label("Settings", systemImage: "gearshape") }
      .tag(Tab.settings)
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

#Preview {
  MainTabView()
}
