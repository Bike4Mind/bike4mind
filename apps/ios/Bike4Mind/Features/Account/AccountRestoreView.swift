import B4MKit
import SwiftUI

/// Shown instead of the shell while the signed-in account is waiting to be deleted: restore it or sign out.
struct AccountRestoreView: View {
  let scheduledFor: Date?

  @Environment(AppServices.self) private var services

  var body: some View {
    AccountRestoreContent(
      scheduledFor: scheduledFor,
      model: AccountRestoreViewModel(
        api: services.account,
        didRestore: { [services] in services.accountStatus.reset() }),
      signOut: { [services] in await services.signOutEverywhere() })
  }
}

private struct AccountRestoreContent: View {
  let scheduledFor: Date?
  let signOut: () async -> Void

  @State private var model: AccountRestoreViewModel
  @State private var isSigningOut = false

  init(scheduledFor: Date?, model: AccountRestoreViewModel, signOut: @escaping () async -> Void) {
    self.scheduledFor = scheduledFor
    self.signOut = signOut
    _model = State(initialValue: model)
  }

  var body: some View {
    ScrollView {
      VStack(spacing: Tokens.Spacing.l) {
        Image(systemName: "person.crop.circle.badge.clock")
          .font(.largeTitle)
          .imageScale(.large)
          .foregroundStyle(Tokens.Palette.warning)
          .accessibilityHidden(true)
        Text("Your account is scheduled for deletion")
          .font(.title2.bold())
          .foregroundStyle(Tokens.Palette.primaryText)
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        Text(deadlineText)
          .foregroundStyle(Tokens.Palette.primaryText)
          .multilineTextAlignment(.center)
        Text(
          "Restoring your account brings back your conversations and files. It does not reinstate subscriptions that were canceled; you will need to subscribe again."
        )
        .font(Tokens.Typography.caption)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .multilineTextAlignment(.center)

        if case .failed(let error) = model.state {
          Text(error.message)
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.destructive)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("account-restore-error-text")
        }

        Button {
          Task { await model.restore() }
        } label: {
          HStack(spacing: Tokens.Spacing.s) {
            if model.isRestoring { ProgressView().tint(.white) }
            Text("Restore my account")
          }
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(model.isRestoring || isSigningOut)
        .accessibilityIdentifier("account-restore-btn")

        Button("Sign Out") {
          isSigningOut = true
          Task {
            await signOut()
            isSigningOut = false
          }
        }
        .frame(minHeight: 44)
        .disabled(model.isRestoring || isSigningOut)
        .accessibilityIdentifier("account-restore-signout-btn")
      }
      .padding(Tokens.Spacing.l)
      .frame(maxWidth: Tokens.Layout.readableWidth)
      .frame(maxWidth: .infinity)
    }
    .background(Tokens.Palette.background)
  }

  private var deadlineText: String {
    guard let scheduledFor else {
      return "It will be permanently deleted at the end of the 30-day grace period unless you restore it."
    }
    return
      "It will be permanently deleted on \(scheduledFor.formatted(date: .long, time: .omitted)) unless you restore it."
  }
}
