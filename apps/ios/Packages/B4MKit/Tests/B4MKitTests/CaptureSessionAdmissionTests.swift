import XCTest

@testable import B4MKit

@MainActor
final class CaptureSessionAdmissionTests: XCTestCase {
  func testColdOfflineEnqueue() async throws {
    try await CaptureAdmissionScenarios.coldOffline()
  }

  func testStaleComposerAfterAnotherAccount() async throws {
    try await CaptureAdmissionScenarios.oldComposer(sameUser: false)
  }

  func testStaleComposerAfterSameAccountReauthentication() async throws {
    try await CaptureAdmissionScenarios.oldComposer(sameUser: true)
  }

  func testDestinationCapabilityRejectsStalePublication() async throws {
    try await CaptureAdmissionScenarios.destinationBinding()
  }

  func testEndCleanupDrainsAdmittedPayloadStaging() async throws {
    try await CaptureAdmissionScenarios.endingWaitsForPayloadStaging()
  }

  func testSameSecondAttemptClaimsOneDirectWriter() async throws {
    try await CaptureAdmissionScenarios.sameSecondAttemptClaim()
  }

  func testCleanupFailuresBlockAdmissionAndRecoverTheOriginalTarget() async throws {
    try await CaptureAdmissionScenarios.cleanupFailureRecovery()
  }

  func testDeferredRestoreCannotReportSignOutSuccess() async throws {
    try await CaptureAdmissionScenarios.deferredRestoreCannotReportSignOutSuccess()
  }

  func testStaleSignOutScopeCannotEndTheReplacementLogin() async throws {
    try await CaptureAdmissionScenarios.staleSignOutScopeCannotEndNewLogin()
  }

  func testStaleScanCannotOverwriteCompletion() async throws {
    try await CaptureAdmissionScenarios.staleScanCannotOverwriteCompletion()
  }
  func testUncertainDeliveryRequiresReconciliation() async throws {
    try await CaptureAdmissionScenarios.uncertainDeliveryRequiresReconciliation()
  }

  func testAttemptReadbackFailureCannotDispatch() async throws {
    try await CaptureAdmissionScenarios.attemptReadbackFailureCannotDispatch()
  }

}
