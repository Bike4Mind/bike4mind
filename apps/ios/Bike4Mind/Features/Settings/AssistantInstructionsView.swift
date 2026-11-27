import B4MKit
import SwiftUI

struct AssistantInstructionsView: View {
  @Environment(AppServices.self) private var services

  var body: some View {
    AssistantInstructionsContent(api: services.instructions)
  }
}

private struct AssistantInstructionsContent: View {
  @State private var model: InstructionsViewModel
  @FocusState private var isEditing: Bool

  init(api: any InstructionAPI) {
    _model = State(initialValue: InstructionsViewModel(api: api))
  }

  var body: some View {
    Form {
      Group {
        addSection
        listSection
      }
      .listRowBackground(Tokens.Palette.groupedBackground)
    }
    .brandedListChrome()
    .navigationTitle("Assistant instructions")
    .navigationBarTitleDisplayMode(.inline)
    .task { await model.load() }
    .refreshable { await model.load() }
    .alert(
      "Couldn't update instructions",
      isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(model.errorMessage ?? "")
    }
  }

  private var addSection: some View {
    @Bindable var model = model
    return Section {
      TextField("Always lead with anything about invoices", text: $model.draft, axis: .vertical)
        .lineLimit(1...4)
        .focused($isEditing)
        .submitLabel(.done)
        .disabled(model.limitReached)
        .accessibilityIdentifier("instructions-draft-field")
      Button("Add") {
        Task {
          await model.add()
          if model.draft.isEmpty { isEditing = false }
        }
      }
      .disabled(!model.canAdd)
      .accessibilityIdentifier("instructions-add-btn")
    } footer: {
      Text(addFooter)
    }
  }

  private var addFooter: String {
    if model.limitReached {
      return "You can keep up to \(AssistantInstruction.maxCount) instructions. Remove one to add another."
    }
    let used = model.draft.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    return "Your brief follows these when it decides what to highlight and how to word it. "
      + "\(used)/\(AssistantInstruction.maxLength)"
  }

  @ViewBuilder private var listSection: some View {
    switch model.state {
    case .loading where model.instructions.isEmpty:
      Section { ProgressView().frame(maxWidth: .infinity) }
    case .failed where model.instructions.isEmpty:
      Section {
        Text("Couldn't load your instructions. Pull to try again.")
          .foregroundStyle(Tokens.Palette.secondaryText)
          .accessibilityIdentifier("instructions-load-error")
      }
    default:
      if model.instructions.isEmpty {
        Section {
          Text(
            "No instructions yet. Try \"Always lead with anything about invoices\" or \"Keep the headline under ten words.\""
          )
          .foregroundStyle(Tokens.Palette.secondaryText)
          .accessibilityIdentifier("instructions-empty-state")
        }
      } else {
        Section("Saved") {
          ForEach(model.instructions) { instruction in
            Text(instruction.text)
              .foregroundStyle(Tokens.Palette.primaryText)
              .accessibilityIdentifier("instructions-row")
          }
          .onDelete { offsets in
            let ids = offsets.map { model.instructions[$0].id }
            Task { for id in ids { await model.remove(id: id) } }
          }
        }
      }
    }
  }
}
