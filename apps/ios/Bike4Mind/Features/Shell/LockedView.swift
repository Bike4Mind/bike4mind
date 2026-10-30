import B4MKit
import SwiftUI

/// Shown while App Lock hides the signed-in UI. Prompts automatically on appearance.
struct LockedView: View {
  @Environment(AuthController.self) private var auth

  var body: some View {
    VStack(spacing: Tokens.Spacing.l) {
      Image(systemName: "lock.fill")
        .font(.system(size: 48))
        .foregroundStyle(Tokens.Palette.brand)
        .accessibilityHidden(true)
      Text("Bike4Mind is locked")
        .font(.title2.weight(.semibold))
      Button("Unlock") {
        Task { await auth.unlock() }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .accessibilityIdentifier("lock-unlock-btn")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Tokens.Palette.background)
    .task { await auth.unlock() }
  }
}
