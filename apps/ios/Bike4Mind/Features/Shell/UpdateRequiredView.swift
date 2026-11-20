import B4MKit
import SwiftUI

/// Covers the whole app while the server no longer serves this build. Nothing is signed out: once the
/// update is installed (or the minimum is lowered and "Try again" succeeds) the app is exactly as it was.
struct UpdateRequiredView: View {
  let minimumVersion: String?
  let isChecking: Bool
  let tryAgain: () -> Void

  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(spacing: Tokens.Spacing.l) {
        Image(systemName: "arrow.down.app.fill")
          .font(.largeTitle)
          .imageScale(.large)
          .foregroundStyle(Tokens.Palette.brand)
          .accessibilityHidden(true)
        Text("Update required")
          .font(.title2.bold())
          .foregroundStyle(Tokens.Palette.primaryText)
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        Text(explanation)
          .foregroundStyle(Tokens.Palette.primaryText)
          .multilineTextAlignment(.center)
          .accessibilityIdentifier("update-required-message-text")
        Text("You stay signed in, and your conversations are safe.")
          .font(Tokens.Typography.caption)
          .foregroundStyle(Tokens.Palette.secondaryText)
          .multilineTextAlignment(.center)

        Button {
          openURL(AppLinks.appStore)
        } label: {
          Text("Open the App Store")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .accessibilityIdentifier("update-required-appstore-btn")

        Button(action: tryAgain) {
          HStack(spacing: Tokens.Spacing.s) {
            if isChecking { ProgressView() }
            Text("Try again")
          }
          .frame(minHeight: 44)
        }
        .disabled(isChecking)
        .accessibilityIdentifier("update-required-retry-btn")
      }
      .padding(Tokens.Spacing.l)
      .frame(maxWidth: Tokens.Layout.readableWidth)
      .frame(maxWidth: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Tokens.Palette.background)
  }

  private var explanation: String {
    let installed = "You have version \(AppInfo.versionDescription)."
    guard let minimumVersion else {
      return "This version of Bike4Mind is no longer supported. Update the app to keep going. \(installed)"
    }
    return
      "This version of Bike4Mind is no longer supported. Update to version \(minimumVersion) or later to keep going. \(installed)"
  }
}
