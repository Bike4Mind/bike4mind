import B4MKit
import SwiftUI

/// "Hand to assistant" for a scanned bill: shows what the assistant read and lets the user correct it before
/// confirming, which files the scan into the chosen lake and lets the brief remind them before it is due.
struct ObligationConfirmSheet: View {
  @Bindable var model: ObligationHandoffModel
  let onClose: () -> Void

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Bill details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(model.phase == .done ? "Done" : "Cancel", action: onClose)
              .accessibilityIdentifier("obligation-close-btn")
          }
          if model.phase == .reviewing || model.phase == .saving {
            ToolbarItem(placement: .confirmationAction) {
              Button("Confirm") { Task { await model.confirm() } }
                .disabled(!model.canConfirm)
                .accessibilityIdentifier("obligation-confirm-btn")
            }
          }
        }
    }
    .task {
      if model.phase == .uploading { await model.start() }
    }
    .interactiveDismissDisabled(model.phase == .saving)
  }

  @ViewBuilder
  private var content: some View {
    switch model.phase {
    case .uploading:
      ProgressView("Uploading the scan...")
    case .extracting:
      ProgressView("Reading the bill...")
    case .failed(let message):
      ContentUnavailableView(
        "Couldn't read this bill", systemImage: "exclamationmark.triangle", description: Text(message))
    case .done:
      ContentUnavailableView(
        "Saved", systemImage: "checkmark.circle",
        description: Text("Your brief will remind you before it's due."))
    case .reviewing, .saving:
      form
    }
  }

  private var form: some View {
    Form {
      if let summary = model.obligation?.summary, !summary.isEmpty {
        Section { Text(summary).foregroundStyle(.secondary) }
      }
      Section("Amount") {
        HStack {
          TextField("Amount", text: $model.amountText)
            .keyboardType(.decimalPad)
            .accessibilityIdentifier("obligation-amount-field")
          Text(model.currency).foregroundStyle(.secondary)
        }
        if case .failure(let problem) = model.parsedAmount {
          Text(problem == .negative ? "The amount can't be negative." : "Enter a number, or leave it empty.")
            .font(Tokens.Typography.caption)
            .foregroundStyle(.red)
        }
      }
      Section("Payee") {
        TextField("Who it's owed to", text: $model.payee)
          .accessibilityIdentifier("obligation-payee-field")
      }
      Section("Due date") {
        Toggle("Has a due date", isOn: hasDueDate)
          .accessibilityIdentifier("obligation-due-toggle")
        if let due = model.dueDate {
          DatePicker(
            "Due", selection: Binding(get: { due }, set: { model.dueDate = $0 }), displayedComponents: .date
          )
          .accessibilityIdentifier("obligation-due-picker")
        }
      }
      Section("File in") {
        Picker("Data lake", selection: $model.destinationLakeID) {
          Text("Don't file").tag(String?.none)
          ForEach(model.lakes) { lake in
            Text(lake.name).tag(String?.some(lake.id))
          }
        }
        .accessibilityIdentifier("obligation-destination-picker")
      }
      if let problem = model.saveProblem {
        Section {
          Text(problem).foregroundStyle(.red)
            .accessibilityIdentifier("obligation-save-error")
        }
      }
    }
    .disabled(model.phase == .saving)
  }

  private var hasDueDate: Binding<Bool> {
    Binding(
      get: { model.dueDate != nil },
      set: { model.dueDate = $0 ? (model.dueDate ?? .now) : nil })
  }
}
