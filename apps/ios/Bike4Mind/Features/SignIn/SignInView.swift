import AuthenticationServices
import B4MKit
import SwiftUI

struct SignInView: View {
  let signOutReason: AuthController.SignOutReason?

  @Environment(AuthController.self) private var auth
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @State private var isSigningIn = false
  @State private var errorMessage: String?
  @State private var isShowingDebugSettings = false

  var body: some View {
    VStack(spacing: Tokens.Spacing.l) {
      Spacer()
      header
      Spacer()
      footer
    }
    .padding(Tokens.Spacing.l)
    .frame(maxWidth: Tokens.Layout.readableWidth)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Tokens.Palette.background)
    .onAppear {
      if signOutReason == .sessionEnded {
        errorMessage = AuthError.refreshRejected.userMessage
      }
    }
    #if DEBUG
      .sheet(isPresented: $isShowingDebugSettings) {
        NavigationStack { DebugServerView() }
      }
    #endif
  }

  private var header: some View {
    VStack(spacing: Tokens.Spacing.m) {
      Image(systemName: "brain.head.profile")
        .font(.system(size: 64, weight: .regular))
        .foregroundStyle(Tokens.Palette.brand)
        .accessibilityHidden(true)
      Text("Bike4Mind")
        .font(Tokens.Typography.wordmark)
      Text("Your AI workspace, in your pocket.")
        .font(Tokens.Typography.tagline)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .multilineTextAlignment(.center)
    }
  }

  private var footer: some View {
    VStack(spacing: Tokens.Spacing.m) {
      if let errorMessage {
        Text(errorMessage)
          .font(Tokens.Typography.caption)
          .foregroundStyle(Tokens.Palette.destructive)
          .multilineTextAlignment(.center)
          .accessibilityIdentifier("signin-error-text")
      }

      Button(action: signIn) {
        HStack(spacing: Tokens.Spacing.s) {
          if isSigningIn { ProgressView().tint(.white) }
          Text("Sign in with Bike4Mind")
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .buttonBorderShape(.roundedRectangle(radius: Tokens.Radius.control))
      .disabled(isSigningIn)
      .accessibilityIdentifier("signin-submit-btn")

      #if DEBUG
        Button("Server: \(auth.environment.displayName)") { isShowingDebugSettings = true }
          .font(Tokens.Typography.caption)
          .accessibilityIdentifier("signin-debug-server-btn")
      #endif
    }
  }

  private func signIn() {
    isSigningIn = true
    errorMessage = nil
    Task {
      defer { isSigningIn = false }
      do {
        try await auth.signIn(using: SystemWebAuthenticator(session: webAuthenticationSession))
      } catch let error as AuthError {
        errorMessage = error.userMessage
      } catch {
        errorMessage = "Something went wrong. Check your connection and try again."
      }
    }
  }
}

#Preview {
  SignInView(signOutReason: nil)
    .environment(AuthController(environment: .production, tokenStore: InMemoryTokenStore()))
}
