import B4MKit
import SwiftUI

/// App Store Guideline 5.1.1(v): in-app account deletion. Reached from Settings; asks the user to type
/// DELETE, then ends the local session once the server has accepted the request.
struct DeleteAccountView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    DeleteAccountContent(
      api: services.account,
      endSession: { [services] in
        // The server revoked every session with the request; the shared sign-out path still runs so
        // Live Activities end, push unregisters (best effort) and the Keychain is wiped.
        services.accountStatus.beginSignOutAfterDeletion()
        await services.signOutEverywhere(reason: .accountDeletionRequested)
      })
  }
}

private struct DeleteAccountContent: View {
  @State private var model: AccountDeletionViewModel
  @FocusState private var isFieldFocused: Bool

  init(api: any AccountAPI, endSession: @escaping @MainActor () async -> Void) {
    _model = State(initialValue: AccountDeletionViewModel(api: api, endSession: endSession))
  }

  var body: some View {
    @Bindable var model = model
    Form {
      Group {
        formSections
      }
      .listRowBackground(Tokens.Palette.groupedBackground)
    }
    .brandedListChrome()
    .navigationTitle("Delete Account")
    .navigationBarTitleDisplayMode(.inline)
    .interactiveDismissDisabled(model.isDeleting)
    .navigationBarBackButtonHidden(model.isDeleting)
  }

  @ViewBuilder
  private var formSections: some View {
    @Bindable var model = model
    Section {
      Text(
        "Deleting your account removes your profile, conversations, notebooks, files and any remaining credits, and cancels active subscriptions."
      )
      Text(
        "Your account is held for \(AccountDeletionViewModel.gracePeriodDays) days first. Sign in again within that time to restore it; after that it is permanently deleted and cannot be recovered."
      )
    } header: {
      Text("What happens")
    }

    if case .blockedByOrganizations(let organizations) = model.state {
      organizationsSection(organizations)
    }

    Section {
      TextField("Type DELETE to confirm", text: $model.confirmation)
        .textInputAutocapitalization(.characters)
        .autocorrectionDisabled()
        .focused($isFieldFocused)
        .submitLabel(.done)
        .disabled(model.isDeleting)
        .accessibilityIdentifier("delete-account-confirm-field")
    } header: {
      Text("Confirm")
    } footer: {
      if let message = failureMessage {
        Text(message)
          .foregroundStyle(Tokens.Palette.destructive)
          .accessibilityIdentifier("delete-account-error-text")
      }
    }

    Section {
      Button(role: .destructive) {
        isFieldFocused = false
        Task { await model.submit() }
      } label: {
        HStack {
          if model.isDeleting { ProgressView() }
          Text(model.isDeleting ? "Deleting..." : "Delete my account")
        }
        .frame(maxWidth: .infinity, minHeight: 44)
      }
      .disabled(!model.canSubmit)
      .accessibilityIdentifier("delete-account-submit-btn")
    }
  }

  private func organizationsSection(_ organizations: [AccountOrganization]) -> some View {
    Section {
      ForEach(organizations) { organization in
        Label(organization.name, systemImage: "building.2")
      }
    } header: {
      Text("Transfer ownership first")
    } footer: {
      Text(
        "You own these organizations. Transfer ownership of each one to another member, then come back and delete your account."
      )
      .accessibilityIdentifier("delete-account-org-transfer-text")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("delete-account-organizations")
  }

  private var failureMessage: String? {
    switch model.state {
    case .failed(let error): error.message
    case .notPermitted: "Account deletion isn't available for this session."
    case .recentSignInRequired:
      "Deleting your account needs you to confirm your identity, which this app can't do yet. Delete your account from Bike4Mind on the web."
    case .idle, .deleting, .blockedByOrganizations, .completed: nil
    }
  }
}
