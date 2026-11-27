import B4MKit
import SwiftUI

/// Every parameter the selected model takes, rendered from its capabilities. Controls are drawn by kind, never by
/// model, so a model the server adds shows its parameters with no app release.
struct StudioParamsSheet: View {
  @Bindable var model: StudioCreateViewModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        ForEach(model.controls) { control in
          Section {
            row(for: control)
          } header: {
            Text(control.title)
          } footer: {
            if let footer = footer(for: control) { Text(footer) }
          }
        }
        if let credits = model.estimatedCredits {
          Section {
            LabeledContent("Estimated cost") { Text("\(credits) credits").monospacedDigit() }
              .accessibilityIdentifier("studio-params-cost")
          }
        }
      }
      .navigationTitle(model.selectedModel?.name ?? "Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Reset") { model.resetParams() }
            .disabled(model.params.isEmpty)
            .accessibilityIdentifier("studio-params-reset")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("studio-params-done")
        }
      }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("studio-params")
  }

  @ViewBuilder
  private func row(for control: ParamControl) -> some View {
    switch control.kind {
    case .choice(let options):
      ChoiceRow(control: control, options: options, value: binding(for: control))
    case .range(let min, let max, let step):
      RangeRow(control: control, bounds: min...max, step: step, value: binding(for: control))
    case .toggle:
      Toggle(control.title, isOn: flagBinding(for: control))
        .accessibilityIdentifier("studio-param-\(control.key.rawValue)")
    case .seed:
      SeedRow(value: binding(for: control))
    case .text(let maxCharacters):
      TextRow(control: control, maxCharacters: maxCharacters, value: binding(for: control))
    }
  }

  private func footer(for control: ParamControl) -> String? {
    switch control.kind {
    case .seed: "The same seed and prompt give a similar result. Leave it empty for a new one each time."
    case .text(let maxCharacters): "Up to \(maxCharacters) characters."
    default: nil
    }
  }

  private func binding(for control: ParamControl) -> Binding<ParamValue?> {
    Binding(get: { model.value(for: control) }, set: { model.set($0, for: control) })
  }

  private func flagBinding(for control: ParamControl) -> Binding<Bool> {
    Binding(get: { model.value(for: control)?.flag ?? false }, set: { model.set(.flag($0), for: control) })
  }
}

private struct ChoiceRow: View {
  let control: ParamControl
  let options: [ParamOption]
  @Binding var value: ParamValue?

  var body: some View {
    // A model that offers one value has nothing to choose; show what it uses.
    if options.count == 1, control.defaultValue != nil, let only = options.first {
      Text(only.label)
        .foregroundStyle(Tokens.Palette.secondaryText)
        .accessibilityIdentifier("studio-param-\(control.key.rawValue)")
    } else if options.count <= 4 && control.defaultValue != nil {
      picker.pickerStyle(.segmented)
    } else {
      picker.pickerStyle(.menu)
    }
  }

  private var picker: some View {
    Picker(control.title, selection: $value) {
      // A nil default means the server picks; offer that as a real choice so it can be restored.
      if control.defaultValue == nil {
        Text("Default").tag(ParamValue?.none)
      }
      ForEach(options, id: \.value) { option in
        Text(option.value == control.defaultValue ? "\(option.label) (default)" : option.label)
          .tag(Optional(option.value))
      }
    }
    .labelsHidden()
    .accessibilityIdentifier("studio-param-\(control.key.rawValue)")
  }
}

private struct RangeRow: View {
  let control: ParamControl
  let bounds: ClosedRange<Double>
  let step: Double
  @Binding var value: ParamValue?

  private var current: Double { value?.number ?? control.defaultValue?.number ?? bounds.lowerBound }

  var body: some View {
    if bounds.upperBound - bounds.lowerBound <= 10 * step {
      Stepper(value: number, in: bounds, step: step) {
        Text(control.label(for: .number(current)))
      }
      .accessibilityIdentifier("studio-param-\(control.key.rawValue)")
    } else {
      VStack(alignment: .leading) {
        Text(control.label(for: .number(current)))
          .monospacedDigit()
        Slider(value: number, in: bounds, step: step) {
          Text(control.title)
        } minimumValueLabel: {
          Text(control.label(for: .number(bounds.lowerBound))).font(Tokens.Typography.meta)
        } maximumValueLabel: {
          Text(control.label(for: .number(bounds.upperBound))).font(Tokens.Typography.meta)
        }
      }
      .accessibilityIdentifier("studio-param-\(control.key.rawValue)")
    }
  }

  private var number: Binding<Double> {
    Binding(get: { current }, set: { value = .number(($0 / step).rounded() * step) })
  }
}

private struct SeedRow: View {
  @Binding var value: ParamValue?
  @State private var text = ""

  var body: some View {
    HStack {
      TextField("Random", text: $text)
        .keyboardType(.numberPad)
        .monospacedDigit()
        .accessibilityIdentifier("studio-param-seed")
        .onChange(of: text) { _, newText in
          // Rewriting the text re-runs this with the cleaned value, so the field always shows the seed that is sent.
          let digits = String(newText.filter { $0.isASCII && $0.isNumber })
          if digits != newText {
            text = digits
          } else if let seed = Double(digits) {
            if seed > ParamControl.maximumSeed {
              text = String(Int(ParamControl.maximumSeed))
            } else {
              value = .number(seed)
            }
          } else {
            value = nil
          }
        }
      Button {
        text = String(Int.random(in: 0...Int(ParamControl.maximumSeed)))
      } label: {
        Image(systemName: "dice")
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Random seed")
      .accessibilityIdentifier("studio-param-seed-roll")
    }
    .onAppear { text = value?.number.map { String(Int($0)) } ?? "" }
    // Reset clears the value from outside this row; the typed text must follow or it shows a seed that is not sent.
    .onChange(of: value) { _, newValue in if newValue == nil { text = "" } }
  }
}

private struct TextRow: View {
  let control: ParamControl
  let maxCharacters: Int
  @Binding var value: ParamValue?

  var body: some View {
    TextField(control.title, text: text, axis: .vertical)
      .lineLimit(3...10)
      .accessibilityIdentifier("studio-param-\(control.key.rawValue)")
  }

  private var text: Binding<String> {
    Binding(
      get: { value?.text ?? "" },
      set: { newText in
        let clipped = String(newText.prefix(maxCharacters))
        value = clipped.isEmpty ? nil : .text(clipped)
      })
  }
}
