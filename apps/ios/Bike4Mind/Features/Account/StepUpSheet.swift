import B4MKit
import SwiftUI

/// "Confirm it's you": collects a password, authenticator code or emailed code for the step-up gate.
struct StepUpSheet: View {
  @Environment(\.dismiss) private var dismiss
  @State private var model: StepUpViewModel

  init(api: any StepUpAPI, didVerify: @escaping @MainActor () async -> Void) {
    _model = State(initialValue: StepUpViewModel(api: api, didVerify: didVerify))
  }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Confirm it's you")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
              .disabled(model.isSubmitting)
              .accessibilityIdentifier("step-up-cancel-btn")
          }
        }
    }
    .interactiveDismissDisabled(model.isSubmitting)
    .task { await model.load() }
  }

  @ViewBuilder
  private var content: some View {
    switch model.phase {
    case .loading, .verified:
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loadFailed(let error):
      VStack(spacing: Tokens.Spacing.m) {
        Text(error.message)
          .multilineTextAlignment(.center)
        Button("Try again") { Task { await model.load() } }
          .buttonStyle(.borderedProminent)
      }
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .noMethodAvailable:
      Text("This account can't be confirmed in the app. Delete your account from Bike4Mind on the web.")
        .multilineTextAlignment(.center)
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("step-up-no-method-text")
    case .ready:
      form
    }
  }

  private var form: some View {
    @Bindable var model = model
    return Form {
      if model.needsMethodPicker {
        Section {
          Picker("Method", selection: methodBinding) {
            ForEach(model.methods, id: \.self) { method in
              Text(Self.title(for: method)).tag(method)
            }
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("step-up-method-picker")
        }
      }

      Section {
        switch model.selectedMethod {
        case .password:
          SecureField("Password", text: $model.password)
            .textContentType(.password)
            .submitLabel(.go)
            .onSubmit { Task { await model.submit() } }
            .accessibilityIdentifier("step-up-password-field")
        case .totp:
          codeField(prompt: "Authenticator or backup code")
        case .email:
          emailSection
        case nil:
          EmptyView()
        }
      } footer: {
        if let message = model.errorMessage {
          Text(message)
            .foregroundStyle(Tokens.Palette.destructive)
            .accessibilityIdentifier("step-up-error-text")
        }
      }

      Section {
        Button {
          Task { await model.submit() }
        } label: {
          HStack {
            if model.isSubmitting { ProgressView() }
            Text(model.isSubmitting ? "Confirming..." : "Confirm")
          }
          .frame(maxWidth: .infinity, minHeight: 44)
        }
        .disabled(!model.canSubmit)
        .accessibilityIdentifier("step-up-submit-btn")
      }
    }
    .disabled(model.isSubmitting)
  }

  @ViewBuilder
  private var emailSection: some View {
    if model.pendingToken == nil {
      Button {
        Task { await model.sendEmailCode() }
      } label: {
        HStack {
          if model.isSendingCode { ProgressView() }
          Text("Send code")
        }
      }
      .disabled(model.isBusy)
      .accessibilityIdentifier("step-up-send-code-btn")
    } else {
      codeField(prompt: "Code from your email")
      Button("Resend code") { Task { await model.sendEmailCode() } }
        .disabled(model.isBusy)
        .accessibilityIdentifier("step-up-resend-code-btn")
    }
  }

  private func codeField(prompt: String) -> some View {
    @Bindable var model = model
    return TextField(prompt, text: $model.code)
      .keyboardType(.asciiCapable)
      .textContentType(.oneTimeCode)
      .textInputAutocapitalization(.characters)
      .autocorrectionDisabled()
      .submitLabel(.go)
      .onSubmit { Task { await model.submit() } }
      .accessibilityIdentifier("step-up-code-field")
  }

  private var methodBinding: Binding<StepUpMethod> {
    Binding(
      get: { model.selectedMethod ?? .password },
      set: { model.select($0) })
  }

  private static func title(for method: StepUpMethod) -> String {
    switch method {
    case .password: "Password"
    case .totp: "Authenticator"
    case .email: "Email"
    }
  }
}
