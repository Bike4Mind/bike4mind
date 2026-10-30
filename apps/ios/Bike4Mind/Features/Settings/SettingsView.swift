import B4MKit
import SwiftUI

struct SettingsView: View {
  @Environment(AuthController.self) private var auth
  @State private var isConfirmingSignOut = false

  var body: some View {
    @Bindable var auth = auth
    Form {
      Section {
        Toggle("App Lock", isOn: $auth.isAppLockEnabled)
          .disabled(!auth.canUseAppLock)
          .accessibilityIdentifier("settings-applock-toggle")
      } header: {
        Text("Security")
      } footer: {
        Text("Require Face ID, Touch ID or your passcode when returning to Bike4Mind.")
      }

      #if DEBUG
        Section("Developer") {
          NavigationLink("Server: \(auth.environment.displayName)") { DebugServerView() }
        }
      #endif

      Section {
        Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
          .accessibilityIdentifier("settings-signout-btn")
      }
    }
    .navigationTitle("Settings")
    .confirmationDialog("Sign out of Bike4Mind?", isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
      Button("Sign Out", role: .destructive) {
        Task { await auth.signOut() }
      }
    }
  }
}
