import B4MKit
import SwiftUI

struct SessionHandoffPicker: View {
  let sessionID: String
  let client: SessionHandoffClient
  @Environment(\.dismiss) private var dismiss
  @State private var devices: [HandoffDevice] = []
  @State private var busy = true
  @State private var feedback: String?

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text(
            "Web and desktop server conversations must stay open and signed in. iPhone/iPad notifications must be enabled. Local desktop chats stay on that device."
          )
          .font(.footnote)
        }
        ForEach(devices) { device in
          Button {
            Task { await send(device) }
          } label: {
            VStack(alignment: .leading) {
              Text(device.name)
              Text("\(device.platform)\(device.available ? "" : " - inactive")").font(.caption)
            }
          }
          .disabled(busy || !device.available)
          .accessibilityIdentifier("session-handoff-device-btn")
        }
        if busy { ProgressView() }
        if !busy && devices.isEmpty { Text("No registered devices. Open and sign in on your other device first.") }
        if let feedback { Text(feedback).accessibilityIdentifier("session-handoff-feedback") }
      }
      .navigationTitle("Open on another device")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .task {
        do { devices = try await client.devices() } catch { feedback = "Could not load devices. Try again." }
        busy = false
      }
    }
  }

  private func send(_ device: HandoffDevice) async {
    busy = true
    defer { busy = false }
    do {
      try await client.send(sessionID: sessionID, deviceID: device.id)
      feedback = "Sent. Open the notification on your other device."
    } catch APIError.server(status: 409) {
      feedback = "This device looks inactive. Open it, sign in, and try again."
    } catch {
      feedback = "Could not send this conversation. Try again."
    }
  }
}
