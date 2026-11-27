import XCTest

@testable import B4MKit

private let artifactRow = """
  {"id":"a1","type":"mermaid","title":"Signup flow","description":null,"version":2,"version_tag":null,
   "status":"draft","tags":[],"session_id":"s1","project_id":null,"visibility":"private",
   "created_at":"2026-10-01T12:00:00.000Z","updated_at":"2026-10-02T09:30:00.000Z","content":null}
  """

private func unknownTypeRow(id: String) -> String {
  artifactRow.replacingOccurrences(of: "\"a1\"", with: "\"\(id)\"")
    .replacingOccurrences(of: "\"mermaid\"", with: "\"hologram\"")
}

final class ArtifactsClientTests: XCTestCase {
  private let baseURL = URL(string: "https://api.example.test")!

  private func makeClient(_ responder: @escaping FakeTransport.Responder) -> (ArtifactsClient, FakeTransport) {
    let transport = FakeTransport(responder: responder)
    return (ArtifactsClient(baseURL: baseURL, tokens: FakeTokens(), transport: transport), transport)
  }

  func testListSendsCursorAndLimitAndMapsRows() async throws {
    let body = "{\"data\":[\(artifactRow),\(unknownTypeRow(id: "a2"))],\"next_cursor\":\"c2\"}"
    let (client, transport) = makeClient { _ in (200, Data(body.utf8)) }

    let page = try await client.listArtifacts(cursor: "c1", limit: 10)

    let requests = await transport.requests
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url?.path(), "/api/v1/artifacts")
    let query = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
    XCTAssertEqual(Set(query?.map { "\($0.name)=\($0.value ?? "")" } ?? []), ["limit=10", "cursor=c1"])
    XCTAssertEqual(page.nextCursor, "c2")
    XCTAssertEqual(page.items.map(\.id), ["a1", "a2"])
    XCTAssertEqual(page.items[0].kind, .mermaid)
    XCTAssertEqual(page.items[0].sessionID, "s1")
    XCTAssertEqual(page.items[0].version, 2)
    XCTAssertEqual(page.items[0].updatedAt, ISO8601DateFormatter().date(from: "2026-10-02T09:30:00Z"))
    XCTAssertEqual(page.items[1].kind, .other("hologram"), "an unknown type must not fail the list")
  }

  func testDetailReturnsContentAndEncodesTheIDIntoThePath() async throws {
    let body = artifactRow.replacingOccurrences(of: "\"content\":null", with: "\"content\":\"graph TD; A-->B\"")
    let (client, transport) = makeClient { _ in (200, Data(body.utf8)) }

    let artifact = try await client.artifact(id: "a b/1")

    let requests = await transport.requests
    XCTAssertEqual(requests.first?.url?.path(percentEncoded: true), "/api/v1/artifacts/a%20b%2F1")
    XCTAssertEqual(artifact.content, "graph TD; A-->B")
    XCTAssertEqual(artifact.summary.displayTitle, "Signup flow")
  }

  func testErrorsMapToAPIErrors() async {
    let error = APIFixtures.errorBody
    for (status, expected) in [(403, APIError.forbidden), (404, .notFound), (429, .rateLimited)] {
      let (client, _) = makeClient { _ in (status, Data(error.utf8)) }
      do {
        _ = try await client.artifact(id: "a1")
        XCTFail("expected an error")
      } catch {
        XCTAssertEqual(error as? APIError, expected)
      }
    }
  }

  func testFeatureFlagReadsClientConfig() async throws {
    let on = #"{"features":{"artifacts":true}}"#
    let (enabledClient, transport) = makeClient { _ in (200, Data(on.utf8)) }
    let enabled = try await enabledClient.artifactsEnabled()
    XCTAssertTrue(enabled)
    let requests = await transport.requests
    XCTAssertEqual(requests.first?.url?.path(), "/api/v1/client-config")

    for body in [#"{"features":{"artifacts":false}}"#, #"{"features":{}}"#, "{}"] {
      let (client, _) = makeClient { _ in (200, Data(body.utf8)) }
      let flag = try await client.artifactsEnabled()
      XCTAssertFalse(flag, body)
    }
  }

  func testFeatureFlagFailuresThrow() async {
    let (serverDown, _) = makeClient { _ in (503, Data()) }
    do {
      _ = try await serverDown.artifactsEnabled()
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? APIError, .server(status: 503))
    }
    let (garbled, _) = makeClient { _ in (200, Data("not json".utf8)) }
    do {
      _ = try await garbled.artifactsEnabled()
      XCTFail("expected an error")
    } catch {
      XCTAssertEqual(error as? APIError, .malformedResponse)
    }
  }
}

final class ArtifactKindTests: XCTestCase {
  func testRenderingPerType() {
    let expectations: [(String, ArtifactRendering)] = [
      ("html", .web), ("svg", .web), ("mermaid", .mermaid), ("code", .code), ("python", .code),
      ("file", .code), ("blog-draft", .markdown), ("react", .fullVersion), ("recharts", .fullVersion),
      ("lattice", .fullVersion), ("chess", .fullVersion), ("quest", .unsupported),
    ]
    for (wire, rendering) in expectations {
      XCTAssertEqual(ArtifactKind(wire: wire).rendering, rendering, wire)
    }
  }

  func testWebURLPointsAtTheArtifactInTheWebApp() {
    let summary = ArtifactSummary(id: "abc123", kind: .react, title: "t", updatedAt: Date())
    XCTAssertEqual(summary.webURL?.path(), "/artifacts/abc123")
    XCTAssertEqual(summary.webURL?.scheme, "https")
  }

  func testUntitledArtifactGetsATypeBasedTitle() {
    let summary = ArtifactSummary(id: "1", kind: .python, title: "  ", updatedAt: Date())
    XCTAssertEqual(summary.displayTitle, "Untitled Python")
  }
}

final class ArtifactWebDocumentTests: XCTestCase {
  func testPolicyIsInstalledFirstInTheHead() {
    let html = ArtifactWebDocument.html(from: "<html><head><title>x</title></head><body>hi</body></html>")
    let policy = html.range(of: "Content-Security-Policy")
    let title = html.range(of: "<title>")
    XCTAssertNotNil(policy)
    XCTAssertLessThan(policy!.lowerBound, title!.lowerBound)
    XCTAssertTrue(html.contains("connect-src 'none'"))
    XCTAssertTrue(html.contains("form-action 'none'"))
  }

  func testFragmentsAreWrappedInADocument() {
    let html = ArtifactWebDocument.html(from: "<h1>Hello</h1>")
    XCTAssertTrue(html.hasPrefix("<!doctype html>"))
    XCTAssertTrue(html.contains("<body><h1>Hello</h1></body>"))
  }

  func testEscapeHatchesAreStripped() {
    let source = """
      <head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">
      <META HTTP-EQUIV="Content-Security-Policy" content="default-src *"></head>
      <body><IFRAME src="https://evil.test"></IFRAME><object data="x"></object><embed src="y">ok</body>
      """
    let html = ArtifactWebDocument.html(from: source)
    for needle in ["<base", "refresh", "default-src *", "<iframe", "<object", "<embed"] {
      XCTAssertFalse(html.lowercased().contains(needle), needle)
    }
    XCTAssertTrue(html.contains("ok"))
  }

  func testUnclosedIframeDoesNotSwallowThePolicy() {
    let html = ArtifactWebDocument.html(from: "<body><iframe src=x>trailing")
    XCTAssertTrue(html.contains("Content-Security-Policy"))
    XCTAssertFalse(html.lowercased().contains("<iframe"))
  }

  func testMermaidSourceIsEmbeddedAsInertData() {
    let source = "graph TD; A[\"</script><script>alert(1)</script>\"]-->B"
    let html = ArtifactWebDocument.html(fromMermaid: source, mermaidLibrary: "/*lib*/", darkMode: true)
    XCTAssertFalse(html.contains("</script><script>alert(1)"))
    XCTAssertTrue(html.contains("theme: 'dark'"))
    XCTAssertTrue(html.contains("securityLevel: 'strict'"))
    XCTAssertFalse(
      html.contains("script-src 'unsafe-inline' 'unsafe-eval' https:"), "bundled library needs no remote scripts")
  }

  func testSVGIsSanitizedAndScaled() {
    let html = ArtifactWebDocument.html(fromSVG: "<svg width=\"2000\"><iframe src=x></iframe><rect/></svg>")
    XCTAssertFalse(html.lowercased().contains("<iframe"))
    XCTAssertTrue(html.contains("max-width:100%"))
  }
}

private final class FakeArtifactsAPI: ArtifactsAPI, @unchecked Sendable {
  var enabled: Result<Bool, APIError> = .success(true)
  var pages: [String?: Result<Page<ArtifactSummary>, APIError>] = [:]
  var detail: Result<Artifact, APIError> = .failure(.notFound)
  private(set) var listCalls: [String?] = []
  private(set) var flagCalls = 0

  func artifactsEnabled() async throws -> Bool {
    flagCalls += 1
    return try enabled.get()
  }

  func listArtifacts(cursor: String?, limit: Int) async throws -> Page<ArtifactSummary> {
    listCalls.append(cursor)
    return try (pages[cursor] ?? .success(Page(items: [], nextCursor: nil))).get()
  }

  func artifact(id: String) async throws -> Artifact { try detail.get() }
}

private func row(_ id: String) -> ArtifactSummary {
  ArtifactSummary(id: id, kind: .html, title: "Artifact \(id)", updatedAt: Date())
}

@MainActor
final class ArtifactsViewModelTests: XCTestCase {
  func testDisabledFeatureNeverFetchesTheList() async {
    let api = FakeArtifactsAPI()
    api.enabled = .success(false)
    let model = ArtifactsViewModel(api: api)

    await model.load()

    XCTAssertEqual(model.isFeatureEnabled, false)
    XCTAssertEqual(model.state, .loaded)
    XCTAssertTrue(api.listCalls.isEmpty)
  }

  func testFirstPageThenNextPageAppendsAndDedups() async {
    let api = FakeArtifactsAPI()
    api.pages[nil] = .success(Page(items: [row("1"), row("2")], nextCursor: "c2"))
    api.pages["c2"] = .success(Page(items: [row("2"), row("3")], nextCursor: nil))
    let model = ArtifactsViewModel(api: api)

    await model.load()
    XCTAssertEqual(model.artifacts.map(\.id), ["1", "2"])
    XCTAssertTrue(model.hasMore)

    await model.loadMore()
    XCTAssertEqual(model.artifacts.map(\.id), ["1", "2", "3"])
    XCTAssertFalse(model.hasMore)
    await model.loadMore()
    XCTAssertEqual(api.listCalls, [nil, "c2"], "no request once the cursor is exhausted")
  }

  func testFlagIsOnlyFetchedUntilItIsKnownOn() async {
    let api = FakeArtifactsAPI()
    let model = ArtifactsViewModel(api: api)
    await model.load()
    await model.refresh()
    XCTAssertEqual(api.flagCalls, 1)
  }

  func testFailedRefreshKeepsRowsAndFailedLoadMoreIsReportedApart() async {
    let api = FakeArtifactsAPI()
    api.pages[nil] = .success(Page(items: [row("1")], nextCursor: "c2"))
    api.pages["c2"] = .failure(.offline)
    let model = ArtifactsViewModel(api: api)
    await model.load()

    await model.loadMore()
    XCTAssertEqual(model.loadMoreError, .offline)
    XCTAssertEqual(model.state, .loaded)

    api.pages[nil] = .failure(.server(status: 500))
    await model.refresh()
    XCTAssertEqual(model.state, .failed(.server(status: 500)))
    XCTAssertEqual(model.artifacts.map(\.id), ["1"])
  }

  func testDetailLoadsContentOrReportsFailure() async {
    let api = FakeArtifactsAPI()
    let summary = row("1")
    api.detail = .success(Artifact(summary: summary, content: "<p>hi</p>"))
    let model = ArtifactDetailViewModel(summary: summary, api: api)
    XCTAssertEqual(model.phase, .loading)

    await model.load()
    XCTAssertEqual(model.phase, .loaded(Artifact(summary: summary, content: "<p>hi</p>")))

    api.detail = .failure(.notFound)
    await model.load()
    XCTAssertEqual(model.phase, .failed(.notFound))
  }
}
