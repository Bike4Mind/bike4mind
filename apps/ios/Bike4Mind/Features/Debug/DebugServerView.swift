#if DEBUG
  import B4MKit
  import SwiftUI

  /// DEBUG-only server picker for staging and preview stages. Switching servers signs out,
  /// because tokens belong to the server that minted them.
  struct DebugServerView: View {
    @Environment(AuthController.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @State private var useCustomServer = false
    @State private var customURLText = ""

    private let store = ServerEnvironmentStore()

    var body: some View {
      Form {
        Section {
          Picker("Server", selection: $useCustomServer) {
            Text("Production").tag(false)
            Text("Custom").tag(true)
          }
          .pickerStyle(.segmented)

          if useCustomServer {
            TextField("https://staging.example.com", text: $customURLText)
              .keyboardType(.URL)
              .textContentType(.URL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityIdentifier("debug-server-url-input")
          }
        } footer: {
          Text("Changing the server signs you out.")
        }

        Section {
          Button("Apply", action: apply)
            .disabled(selectedEnvironment == nil)
            .accessibilityIdentifier("debug-server-apply-btn")
        }
      }
      .navigationTitle("Server")
      .onAppear(perform: loadCurrent)
    }

    /// `nil` while the custom URL is not a usable http(s) origin.
    private var selectedEnvironment: ServerEnvironment? {
      guard useCustomServer else { return .production }
      guard let url = URL(string: customURLText.trimmingCharacters(in: .whitespaces)),
        let scheme = url.scheme, ["https", "http"].contains(scheme), url.host() != nil
      else {
        return nil
      }
      return .custom(url)
    }

    private func loadCurrent() {
      if case .custom(let url) = auth.environment {
        useCustomServer = true
        customURLText = url.absoluteString
      }
    }

    private func apply() {
      guard let environment = selectedEnvironment else { return }
      store.save(environment)
      Task {
        await auth.switchEnvironment(to: environment)
        dismiss()
      }
    }
  }
#endif
