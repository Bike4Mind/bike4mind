import B4MKit
import SwiftUI

/// The destination picker, note field and Send button shared by the share extension and the in-app capture
/// sheet. Compiled into both targets, so it uses only system styling plus B4MKit's BrandTheme; the explicit
/// tint matters in the share extension, which has no asset-catalog accent of its own.
struct ShareComposerView: View {
  @State var model: ShareComposerModel
  let onFinish: () -> Void
  let onCancel: () -> Void
  /// Guards `onFinish`: the Done button and the automatic close after "Sent" must not both complete the host.
  @State private var didFinish = false

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Save to Bike4Mind")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(model.dismissButtonTitle, action: model.phase == .sent ? finish : onCancel)
              .accessibilityIdentifier(model.phase == .sent ? "share-done-btn" : "share-cancel-btn")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Send") { Task { await send() } }
              .disabled(!model.canSubmit)
              .accessibilityIdentifier("share-send-btn")
          }
        }
    }
    .tint(BrandTheme.accent)
    .task { await model.load() }
    .interactiveDismissDisabled(model.phase == .submitting)
  }

  @ViewBuilder
  private var content: some View {
    switch model.phase {
    case .loading:
      ProgressView("Loading").frame(maxWidth: .infinity, maxHeight: .infinity)
    case .sent:
      ContentUnavailableView(
        "Sent", systemImage: "checkmark.circle.fill",
        description: Text("It will finish uploading in the background."))
    default:
      form
    }
  }

  private var form: some View {
    Form {
      Section("Items") {
        ForEach(Array(model.items.enumerated()), id: \.offset) { index, item in
          HStack {
            Image(systemName: Self.symbol(for: item)).foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading) {
              Text(item.displayName).lineLimit(2)
              Text(item.kindLabel).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.items.count > 1 {
              Button(role: .destructive) {
                model.remove(at: index)
              } label: {
                Image(systemName: "minus.circle")
              }
              .buttonStyle(.borderless)
              .frame(minWidth: 44, minHeight: 44)
              .accessibilityLabel("Remove \(item.displayName)")
            }
          }
        }
      }
      Section("Destination") {
        if let warning = model.loadWarning {
          Label(warning, systemImage: "exclamationmark.triangle")
            .foregroundStyle(BrandTheme.warning).font(.footnote)
        }
        NavigationLink {
          DestinationPicker(model: model)
        } label: {
          LabeledContent("Save to", value: model.destination?.name ?? "Choose")
        }
        .accessibilityIdentifier("share-destination-picker")
        if model.destination?.isLake == false {
          Text("Sending to a notebook starts a chat turn for each item and uses credits.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
      Section("Note") {
        TextField("Add a note (optional)", text: $model.note, axis: .vertical)
          .lineLimit(1...4)
          .accessibilityIdentifier("share-note-field")
      }
      if case .failed(let message) = model.phase {
        Section {
          Label(message, systemImage: "exclamationmark.octagon").foregroundStyle(BrandTheme.destructive)
            .accessibilityIdentifier("share-error-label")
        }
      }
      if model.phase == .submitting {
        Section { ProgressView("Sending") }
      }
    }
  }

  private func send() async {
    await model.submit()
    guard model.phase == .sent else { return }
    try? await Task.sleep(for: .milliseconds(900))
    finish()
  }

  private func finish() {
    guard !didFinish else { return }
    didFinish = true
    onFinish()
  }

  private static func symbol(for item: ShareItem) -> String {
    switch item {
    case .url: "link"
    case .text: "text.alignleft"
    case .image: "photo"
    case .pdf: "doc.richtext"
    case .file: "doc"
    }
  }
}

/// The destination list pushed from the composer. Choosing a row pops back at once, which the system's
/// navigation-link `Picker` does not do reliably inside a sectioned list.
private struct DestinationPicker: View {
  let model: ShareComposerModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      if !model.lakes.isEmpty {
        Section("Lakes") {
          ForEach(model.lakes) { lake in row(.lake(id: lake.id, name: lake.name)) }
        }
      }
      if !model.sessions.isEmpty {
        Section("Notebooks") {
          ForEach(model.sessions) { session in
            row(.session(id: session.id, name: session.title))
          }
        }
      }
      // A remembered destination whose list failed to load must stay selectable.
      if let current = model.destination, !isListed(current) {
        row(current)
      }
    }
    .navigationTitle("Save to")
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("share-destination-list")
  }

  private func row(_ destination: CaptureDestination) -> some View {
    Button {
      model.choose(destination)
      dismiss()
    } label: {
      HStack {
        Text(destination.name).foregroundStyle(.primary)
        Spacer()
        if model.destination == destination {
          Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(model.destination == destination ? .isSelected : [])
  }

  private func isListed(_ destination: CaptureDestination) -> Bool {
    switch destination {
    case .lake(let id, _): model.lakes.contains { $0.id == id }
    case .session(let id, _): model.sessions.contains { $0.id == id }
    }
  }
}
