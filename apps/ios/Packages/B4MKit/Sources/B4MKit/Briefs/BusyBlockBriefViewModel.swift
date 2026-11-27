import Foundation
import Observation

/// Drives the busy-block brief toggle using work admitted before any permission or network wait.
@MainActor
@Observable
public final class BusyBlockBriefViewModel {
  public private(set) var isEnabled = false
  public private(set) var isLoaded = false
  public private(set) var isSaving = false
  public private(set) var isAccessDenied = false
  public private(set) var errorMessage: String?

  @ObservationIgnored private let reader: any BusyBlockReader
  @ObservationIgnored private let syncer: BusyBlockSyncer
  @ObservationIgnored private var scopeID: UUID?
  @ObservationIgnored private var loadID: UUID?
  @ObservationIgnored private var saveID: UUID?

  public init(api: any BusyBlocksAPI, reader: any BusyBlockReader, syncer: BusyBlockSyncer? = nil) {
    self.reader = reader
    self.syncer = syncer ?? BusyBlockSyncer(api: api, reader: reader)
  }

  @discardableResult
  public func scheduleLoad() -> Task<Void, Never> {
    let admission = syncer.captureAdmission()
    return Task { await load(admission: admission) }
  }

  public func load() async { await load(admission: syncer.captureAdmission()) }

  private func load(admission: BusyBlockSyncer.Admission) async {
    guard bind(admission) else { return }
    let owner = UUID()
    loadID = owner
    do {
      let state = try await admission.session.api.state()
      guard syncer.isCurrent(admission), loadID == owner, saveID == nil else { return }
      isEnabled = state.enabled
      isLoaded = true
      errorMessage = nil
    } catch {
      guard syncer.isCurrent(admission), loadID == owner, saveID == nil else { return }
      errorMessage = "Couldn't load your busy-block setting. Try again later."
    }
  }

  @discardableResult
  public func scheduleSetEnabled(_ isOn: Bool) -> Task<Void, Never> {
    let admission = syncer.captureAdmission()
    return Task { await setEnabled(isOn, admission: admission) }
  }

  public func setEnabled(_ isOn: Bool) async {
    await setEnabled(isOn, admission: syncer.captureAdmission())
  }

  private func setEnabled(_ isOn: Bool, admission: BusyBlockSyncer.Admission) async {
    let previousScope = scopeID
    guard bind(admission) else { return }
    // A retained view must load the new account before submitting its old displayed value.
    guard previousScope == nil || previousScope == scopeID else { return }
    guard !isSaving else { return }
    let owner = UUID()
    saveID = owner
    loadID = nil
    isSaving = true
    defer {
      if saveID == owner { saveID = nil; isSaving = false }
    }
    errorMessage = nil
    if isOn {
      let allowed = await reader.requestAccess()
      guard ownsSave(owner, admission) else { return }
      guard allowed else {
        isEnabled = false
        isAccessDenied = true
        return
      }
      isAccessDenied = false
    }
    guard ownsSave(owner, admission) else { return }
    let previous = isEnabled
    isEnabled = isOn
    do {
      let state = try await syncer.save(enabled: isOn, admission: admission)
      guard ownsSave(owner, admission) else { return }
      isEnabled = state.enabled
    } catch is CancellationError {
      if ownsSave(owner, admission) { isEnabled = previous }
    } catch {
      guard ownsSave(owner, admission) else { return }
      isEnabled = previous
      errorMessage = "Couldn't save your busy-block setting. Try again."
    }
  }

  private func ownsSave(_ owner: UUID, _ admission: BusyBlockSyncer.Admission) -> Bool {
    saveID == owner && syncer.isCurrent(admission)
  }

  private func bind(_ admission: BusyBlockSyncer.Admission) -> Bool {
    guard syncer.isCurrent(admission) else { return false }
    if scopeID != admission.session.id {
      scopeID = admission.session.id
      loadID = nil
      saveID = nil
      isEnabled = false
      isLoaded = false
      isSaving = false
      isAccessDenied = false
      errorMessage = nil
    }
    return true
  }
}
