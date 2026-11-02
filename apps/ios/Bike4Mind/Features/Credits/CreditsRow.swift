import B4MKit
import SwiftUI

/// The credit balance as a Settings row; loads when Settings appears.
struct CreditsSection: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    CreditsContent(api: services.api)
  }
}

private struct CreditsContent: View {
  @State private var model: CreditsViewModel

  init(api: any B4MAPI) {
    _model = State(initialValue: CreditsViewModel(api: api))
  }

  var body: some View {
    Section("Account") {
      LabeledContent {
        value
      } label: {
        Label("Credits", systemImage: "creditcard")
      }
      .accessibilityIdentifier("settings-credits-row")
      .task { await model.load() }
    }
  }

  @ViewBuilder
  private var value: some View {
    if let balance = model.balance {
      Text(CreditsViewModel.formatted(balance.credits))
        .monospacedDigit()
        .foregroundStyle(.primary)
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
