import XCTest

@testable import B4MKit

final class UploadJobStoreTests: XCTestCase {
  private let temp = TempDirectory()
  private let destination = CaptureDestination.lake(id: "l1", name: "Research")

  private func job(_ payload: UploadPayload = .message("x")) -> UploadJob {
    UploadJob(destination: destination, payload: payload, note: "n", now: Date(timeIntervalSince1970: 1_800_000_000))
  }

  func testJobsRoundTripThroughDisk() throws {
    let store = FileUploadJobStore(directory: temp.url)
    var original = job(.file(name: "a b.jpg", mimeType: "image/jpeg", byteCount: 9))
    original.stage = .uploading
    original.ticket = UploadTicket(
      fileID: "f1", uploadURL: URL(string: "https://s3.example.test/x?sig=1")!,
      expiresAt: Date(timeIntervalSince1970: 1_800_000_600))
    original.uploadSession = BackgroundSessionIdentifier.shareExtension
    original.uploadTaskID = 7
    try store.save(original)

    // A different instance (the other process) reads the same record.
    let loaded = try XCTUnwrap(try FileUploadJobStore(directory: temp.url).load(id: original.id))
    XCTAssertEqual(loaded, original)
  }

  func testLoadAllIsOrderedByCreationAndSkipsDamagedRecords() throws {
    let store = FileUploadJobStore(directory: temp.url)
    let later = UploadJob(
      destination: destination, payload: .message("b"), note: nil, now: Date(timeIntervalSince1970: 20))
    let earlier = UploadJob(
      destination: destination, payload: .message("a"), note: nil, now: Date(timeIntervalSince1970: 10))
    try store.save(later)
    try store.save(earlier)
    let jobsDirectory = temp.url.appending(path: "Capture/jobs")
    try Data("{broken".utf8).write(to: jobsDirectory.appending(path: "\(UUID().uuidString).json"))

    XCTAssertEqual(try store.loadAll().map(\.id), [earlier.id, later.id])
  }

  func testEmptyStoreHasNoJobs() throws {
    XCTAssertEqual(try FileUploadJobStore(directory: temp.url).loadAll(), [])
    XCTAssertNil(try FileUploadJobStore(directory: temp.url).load(id: UUID()))
  }

  func testRemoveDeletesTheRecordAndPayloadAndIsIdempotent() throws {
    let store = FileUploadJobStore(directory: temp.url)
    let job = job()
    try store.save(job)
    let payload = try store.writePayload(Data("bytes".utf8), jobID: job.id, fileName: "a.txt")
    XCTAssertTrue(FileManager.default.fileExists(atPath: payload.path(percentEncoded: false)))
    try store.remove(id: job.id)
    XCTAssertNil(try store.load(id: job.id))
    XCTAssertFalse(FileManager.default.fileExists(atPath: payload.path(percentEncoded: false)))
    XCTAssertNoThrow(try store.remove(id: job.id))
  }

  func testPayloadsAreKeptPerJob() throws {
    let store = FileUploadJobStore(directory: temp.url)
    let source = temp.file("src.bin", contents: Data("abc".utf8))
    let first = UUID()
    let second = UUID()
    let a = try store.stagePayload(copying: source, jobID: first, fileName: "same.bin")
    let b = try store.stagePayload(copying: source, jobID: second, fileName: "same.bin")
    XCTAssertNotEqual(a, b)
    store.discardPayload(jobID: first)
    XCTAssertFalse(FileManager.default.fileExists(atPath: a.path(percentEncoded: false)))
    XCTAssertTrue(FileManager.default.fileExists(atPath: b.path(percentEncoded: false)))
  }

  func testStageStates() {
    XCTAssertTrue(UploadStage.done.isTerminal)
    XCTAssertTrue(UploadStage.failed.isTerminal)
    for stage in [UploadStage.queued, .uploading, .registering] { XCTAssertFalse(stage.isTerminal) }
  }
}

final class SharedContainerTests: XCTestCase {
  func testTheTeamPrefixIsReadFromTheDefaultAccessGroup() {
    XCTAssertEqual(KeychainAccessGroup.teamPrefix(fromDefaultGroup: "ABCDE12345.com.bike4mind.app"), "ABCDE12345.")
    XCTAssertEqual(KeychainAccessGroup.teamPrefix(fromDefaultGroup: "ABCDE12345.com.bike4mind.shared"), "ABCDE12345.")
  }

  func testAnEntitlementlessBuildYieldsNoPrefix() {
    XCTAssertNil(KeychainAccessGroup.teamPrefix(fromDefaultGroup: ""))
    XCTAssertNil(KeychainAccessGroup.teamPrefix(fromDefaultGroup: "com.apple.token"))
    XCTAssertNil(KeychainAccessGroup.teamPrefix(fromDefaultGroup: ".leading"))
    XCTAssertNil(KeychainAccessGroup.teamPrefix(fromDefaultGroup: "nodots"))
    XCTAssertNil(KeychainAccessGroup.teamPrefix(fromDefaultGroup: "SHORT.com.bike4mind.app"))
  }

  func testWithoutTheEntitlementTheGroupFallsBackToNil() {
    // The SwiftPM test host has no keychain-access-groups entitlement, so the probe cannot yield a team prefix.
    XCTAssertNil(KeychainAccessGroup.resolved())
  }

  func testTheContainerFallsBackToAWritableDirectory() throws {
    let directory = SharedContainer.directory()
    var isDirectory: ObjCBool = false
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: directory.path(percentEncoded: false), isDirectory: &isDirectory))
    XCTAssertTrue(isDirectory.boolValue)
    let probe = directory.appending(path: ".probe-\(UUID().uuidString)")
    try Data([1]).write(to: probe)
    try FileManager.default.removeItem(at: probe)
  }

  func testSharedDefaultsAreAlwaysUsable() {
    let defaults = SharedContainer.defaults()
    let key = "b4m.tests.probe.\(UUID().uuidString)"
    defaults.set(true, forKey: key)
    XCTAssertTrue(defaults.bool(forKey: key))
    defaults.removeObject(forKey: key)
  }

  func testBackgroundSessionIdentifiersAreDistinctAndRecognised() {
    XCTAssertNotEqual(BackgroundSessionIdentifier.app, BackgroundSessionIdentifier.shareExtension)
    XCTAssertTrue(BackgroundSessionIdentifier.isCaptureSession(BackgroundSessionIdentifier.app))
    XCTAssertTrue(BackgroundSessionIdentifier.isCaptureSession(BackgroundSessionIdentifier.shareExtension))
    XCTAssertFalse(BackgroundSessionIdentifier.isCaptureSession("com.example.other"))
  }

  func testTheKeychainStoreAcceptsAnAccessGroupAndTheFallbackBehavesLikeBefore() throws {
    // With no group the store is exactly the pre-extension store; round-trips are covered in TokenStoreTests.
    // A hostless simulator test bundle has no keychain entitlement at all, so only the macOS host can read it.
    let store = KeychainTokenStore(
      service: "com.bike4mind.tests.\(UUID().uuidString)", accessGroup: KeychainAccessGroup.resolved())
    let token: String?
    do {
      token = try store.refreshToken()
    } catch let error as KeychainError where error.status == errSecMissingEntitlement {
      throw XCTSkip("no keychain entitlement in this test host")
    }
    XCTAssertNil(token)
  }

  func testShareItemAccessors() {
    let file = SharedFile(
      fileURL: URL(fileURLWithPath: "/tmp/a.png"), fileName: "a.png", mimeType: "image/png", byteCount: 1)
    XCTAssertEqual(ShareItem.image(file).file, file)
    XCTAssertNil(ShareItem.text("x").file)
    XCTAssertEqual(ShareItem.pdf(file).kindLabel, "PDF")
    XCTAssertEqual(ShareItem.url(URL(string: "https://e.com")!).kindLabel, "Link")
    XCTAssertEqual(ShareItem.text(String(repeating: "a", count: 200)).displayName.count, 80)
  }
}

final class AuthorizedRequesterQueryTests: XCTestCase {
  func testQueryItemsAreAppendedToTheURLNotThePath() async throws {
    let transport = FakeTransport { _ in (200, Data()) }
    let requester = AuthorizedRequester(
      baseURL: URL(string: "https://app.example.test")!, tokens: FakeTokens(), transport: transport)
    _ = try await requester.send(
      method: "GET", path: "api/x", query: [URLQueryItem(name: "a", value: "1 2"), URLQueryItem(name: "b", value: "&")])
    let requests = await transport.requests
    let url = try XCTUnwrap(requests.first?.url)
    XCTAssertEqual(url.path(), "/api/x")
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    XCTAssertEqual(items?.map(\.value), ["1 2", "&"])
  }
}
