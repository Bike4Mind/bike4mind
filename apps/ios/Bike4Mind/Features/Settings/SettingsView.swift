import B4MKit
import SwiftUI

struct SettingsView: View {
  @Environment(AuthController.self) private var auth
  @Environment(AppServices.self) private var services
  @State private var isConfirmingSignOut = false

  var body: some View {
    @Bindable var auth = auth
    Form {
      CreditsSection()

      Section {
        NavigationLink("Notifications") { NotificationSettingsView() }
          .accessibilityIdentifier("settings-notifications-link")
      }

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

      Section {
        NavigationLink("Delete Account") { DeleteAccountView() }
          .foregroundStyle(Tokens.Palette.destructive)
          .accessibilityIdentifier("settings-delete-account-link")
      } footer: {
        Text("Permanently deletes your account after a 30-day grace period.")
      }
    }
    .navigationTitle("Settings")
    .confirmationDialog("Sign out of Bike4Mind?", isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
      Button("Sign Out", role: .destructive) {
        Task { await services.signOutEverywhere() }
      }
    }
  }
}
