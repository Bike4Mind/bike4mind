#if DEBUG
  import B4MKit
  import Foundation

  /// Canned artifacts, one per rendering path, so the list and every viewer work offline (`B4M_UI_FIXTURES=1`).
  struct FixtureArtifactsAPI: ArtifactsAPI {
    private static let now = Date()

    private static let all: [Artifact] = [
      make(
        "fixture-artifact-html", .html, "Launch countdown", minutesAgo: 5,
        content: """
          <!doctype html><html><head><style>
          body{font-family:-apple-system,sans-serif;margin:0;padding:32px 20px;background:#0f172a;color:#f8fafc;text-align:center}
          h1{font-size:28px;margin:0 0 8px}.big{font-size:64px;font-weight:700;color:#38bdf8}
          button{margin-top:24px;padding:12px 24px;border:0;border-radius:12px;background:#38bdf8;color:#0f172a;font-size:17px}
          </style></head><body><h1>Launch countdown</h1><div class="big" id="n">10</div>
          <button onclick="document.getElementById('n').textContent=Math.max(0,+document.getElementById('n').textContent-1)">Tick</button>
          </body></html>
          """),
      make(
        "fixture-artifact-svg", .svg, "Orbit diagram", minutesAgo: 42,
        content: """
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
          <circle cx="120" cy="120" r="100" fill="none" stroke="#94a3b8" stroke-dasharray="4 6"/>
          <circle cx="120" cy="120" r="60" fill="none" stroke="#94a3b8" stroke-dasharray="4 6"/>
          <circle cx="120" cy="120" r="22" fill="#f59e0b"/><circle cx="220" cy="120" r="10" fill="#38bdf8"/>
          <circle cx="120" cy="60" r="7" fill="#a78bfa"/></svg>
          """),
      make(
        "fixture-artifact-mermaid", .mermaid, "Signup flow", minutesAgo: 190,
        content: """
          graph TD
            A[Open app] --> B{Has account?}
            B -- Yes --> C[Sign in]
            B -- No --> D[Create account]
            D --> E[Verify email]
            E --> C
            C --> F[Home]
          """),
      make(
        "fixture-artifact-python", .python, "Fibonacci helper", minutesAgo: 60 * 26,
        content: """
          from functools import lru_cache


          @lru_cache(maxsize=None)
          def fib(n: int) -> int:
              if n < 2:
                  return n
              return fib(n - 1) + fib(n - 2)


          print([fib(i) for i in range(10)])
          """),
      make(
        "fixture-artifact-blog", .blogDraft, "Why we ship small", minutesAgo: 60 * 50,
        content: """
          # Why we ship small

          Small changes are **easier to review**, easier to revert and easier to explain.

          ## What that looks like

          - One concern per pull request
          - Tests that fail for the right reason
          - A description a stranger could follow
          """),
      make(
        "fixture-artifact-react", .react, "Pricing calculator", minutesAgo: 60 * 80,
        content: "export default function App() { return null }"),
    ]

    private static func make(
      _ id: String, _ kind: ArtifactKind, _ title: String, minutesAgo: Double, content: String
    )
      -> Artifact
    {
      Artifact(
        summary: ArtifactSummary(
          id: id, kind: kind, title: title, updatedAt: now.addingTimeInterval(-minutesAgo * 60)),
        content: content)
    }

    func artifactsEnabled() async throws -> Bool { true }

    func listArtifacts(cursor: String?, limit: Int) async throws -> Page<ArtifactSummary> {
      Page(items: Self.all.map(\.summary), nextCursor: nil)
    }

    func artifact(id: String) async throws -> Artifact {
      guard let found = Self.all.first(where: { $0.id == id }) else { throw APIError.notFound }
      return found
    }
  }
#endif
