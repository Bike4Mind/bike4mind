import B4MKit
import SwiftUI

/// The credit balance as a Settings row; loads when Settings appears.
struct CreditsSection: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    CreditsContent(model: services.credits)
  }
}

private struct CreditsContent: View {
  let model: CreditsViewModel

  var body: some View {
    Section("Account") {
      LabeledContent {
        value
      } label: {
        Label {
          Text("Credits")
        } icon: {
          Image(systemName: "creditcard").foregroundStyle(Tokens.Palette.brand)
        }
      }
      .accessibilityIdentifier("settings-credits-row")
      .task { await model.load() }
    }
    .listRowBackground(Tokens.Palette.groupedBackground)
  }

  @ViewBuilder
  private var value: some View {
    if let balance = model.balance {
      Text(CreditsViewModel.formatted(balance.credits))
        .monospacedDigit()
        .foregroundStyle(Tokens.Palette.primaryText)
    } else {
      switch model.state {
      case .failed(let error):
        Button {
          Task { await model.load() }
        } label: {
          Label("Retry", systemImage: "arrow.clockwise")
        }
        .buttonStyle(.borderless)
        .accessibilityHint(error.message)
      case .idle, .loading, .loaded:
        ProgressView()
      }
    }
  }
}
