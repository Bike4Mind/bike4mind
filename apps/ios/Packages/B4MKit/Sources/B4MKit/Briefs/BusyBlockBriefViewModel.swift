import Foundation
import Observation

/// Drives the "Brief after busy blocks" toggle in Settings > Notifications. Turning it on asks for calendar access
/// first; a refusal leaves the toggle off and points the user at iOS Settings.
@MainActor
@Observable
public final class BusyBlockBriefViewModel {
  public private(set) var isEnabled = false
  public private(set) var isLoaded = false
  public private(set) var isSaving = false
  public private(set) var isAccessDenied = false
  public private(set) var errorMessage: String?

  @ObservationIgnored private let api: any BusyBlocksAPI
  @ObservationIgnored private let reader: any BusyBlockReader
  @ObservationIgnored private let syncer: BusyBlockSyncer

  public init(api: any BusyBlocksAPI, reader: any BusyBlockReader, syncer: BusyBlockSyncer? = nil) {
    self.api = api
    self.reader = reader
    self.syncer = syncer ?? BusyBlockSyncer(api: api, reader: reader)
  }

  public func load() async {
    do {
      isEnabled = try await api.state().enabled
      isLoaded = true
      errorMessage = nil
    } catch {
      errorMessage = "Couldn't load your busy-block setting. Try again later."
    }
  }

  public func setEnabled(_ isOn: Bool) async {
    guard !isSaving else { return }
    isSaving = true
    defer { isSaving = false }
    errorMessage = nil
    if isOn {
      guard await reader.requestAccess() else {
        isEnabled = false
        isAccessDenied = true
        return
      }
      isAccessDenied = false
    }
    let previous = isEnabled
    isEnabled = isOn
    do {
      isEnabled = try await syncer.save(enabled: isOn).enabled
    } catch {
      isEnabled = previous
      errorMessage = "Couldn't save your busy-block setting. Try again."
    }
  }
}
