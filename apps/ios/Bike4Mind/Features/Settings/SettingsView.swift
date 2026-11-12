import B4MKit
import SwiftUI

struct SettingsView: View {
  @Environment(AuthController.self) private var auth
  @Environment(AppServices.self) private var services
  @State private var isConfirmingSignOut = false
  @State private var profile: AccountProfile?

  var body: some View {
    @Bindable var auth = auth
    Form {
      profileHeader

      CreditsSection()

      Section {
        NavigationLink("Notifications") { NotificationSettingsView() }
          .accessibilityIdentifier("settings-notifications-link")
      }
      .listRowBackground(Tokens.Palette.groupedBackground)

      Section {
        Toggle("App Lock", isOn: $auth.isAppLockEnabled)
          .disabled(!auth.canUseAppLock)
          .accessibilityIdentifier("settings-applock-toggle")
      } header: {
        Text("Security")
      } footer: {
        Text("Require Face ID, Touch ID or your passcode when returning to Bike4Mind.")
      }
      .listRowBackground(Tokens.Palette.groupedBackground)

      Section("About") {
        LabeledContent("Version", value: AppInfo.versionDescription)
          .accessibilityIdentifier("settings-version-row")
        Link("Terms of Service", destination: AppLinks.terms)
        Link("Privacy Policy", destination: AppLinks.privacy)
      }
      .listRowBackground(Tokens.Palette.groupedBackground)

      #if DEBUG
        Section("Developer") {
          NavigationLink("Server: \(auth.environment.displayName)") { DebugServerView() }
        }
        .listRowBackground(Tokens.Palette.groupedBackground)
      #endif

      Section {
        Button("Sign Out", role: .destructive) { isConfirmingSignOut = true }
          .accessibilityIdentifier("settings-signout-btn")
      }
      .listRowBackground(Tokens.Palette.groupedBackground)

      Section {
        NavigationLink("Delete Account") { DeleteAccountView() }
          .foregroundStyle(Tokens.Palette.destructive)
          .accessibilityIdentifier("settings-delete-account-link")
      } footer: {
        Text("Permanently deletes your account after a \(AccountDeletionViewModel.gracePeriodDays)-day grace period.")
      }
      .listRowBackground(Tokens.Palette.groupedBackground)
    }
    .brandedListChrome()
    .navigationTitle("Settings")
    .task { profile = await services.accountProfile() }
    .confirmationDialog("Sign out of Bike4Mind?", isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
      Button("Sign Out", role: .destructive) {
        Task { await services.signOutEverywhere() }
      }
    }
  }

  private var profileHeader: some View {
    Section {
      HStack(spacing: Tokens.Spacing.m) {
        AccountAvatar(initial: profile?.initial, diameter: 56)
        VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
          Text(profile?.displayName ?? profile?.firstName ?? "Your account")
            .font(.headline)
            .foregroundStyle(Tokens.Palette.primaryText)
          if let email = profile?.email {
            Text(email)
              .font(Tokens.Typography.caption)
              .foregroundStyle(Tokens.Palette.secondaryText)
              .textSelection(.enabled)
          }
        }
      }
      .padding(.vertical, Tokens.Spacing.xs)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("settings-profile-header")
    }
    .listRowBackground(Tokens.Palette.groupedBackground)
  }
}
