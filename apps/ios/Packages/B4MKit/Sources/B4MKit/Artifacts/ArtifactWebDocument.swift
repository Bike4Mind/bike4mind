import Foundation

/// Builds the HTML the artifact web view loads. The web app isolates artifacts in a sandboxed iframe under a
/// per-route CSP; neither carries over to a bare `WKWebView`, so this layer does the equivalent: it strips
/// the tags that escape the document, and pins a Content-Security-Policy that lets the artifact draw and run
/// its own scripts but never talk to a server, submit a form or embed another page.
public enum ArtifactWebDocument {
  /// Scripts and styles may be inline or from https hosts (artifacts commonly pull a charting or CSS library from a
  /// CDN); everything that could send data out is closed.
  static let contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' https:",
    "style-src 'unsafe-inline' https:",
    "img-src data: blob: https:",
    "font-src data: https:",
    "media-src data: blob: https:",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].joined(separator: "; ")

  private static let cspTag = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(contentSecurityPolicy)\">"

  private static let viewportTag = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"

  /// Tags that navigate away, embed another document or rewrite relative URLs.
  private static let strippedBlocks = ["iframe", "object", "frameset", "applet"]
  private static let strippedVoidTags = ["base", "embed", "frame"]

  /// `html` with the escape hatches removed and the policy installed.
  public static func html(from source: String) -> String {
    let cleaned = sanitize(source)
    let head = cspTag + viewportTag
    if let range = cleaned.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
      return cleaned.replacingCharacters(in: range, with: cleaned[range] + head)
    }
    if let range = cleaned.range(of: "<html[^>]*>", options: [.regularExpression, .caseInsensitive]) {
      return cleaned.replacingCharacters(in: range, with: cleaned[range] + "<head>" + head + "</head>")
    }
    return "<!doctype html><html><head>\(head)</head><body>\(cleaned)</body></html>"
  }

  /// An SVG artifact shown on a neutral page, scaled to the screen width.
  public static func html(fromSVG svg: String) -> String {
    let body = "<div style=\"display:flex;justify-content:center\">\(sanitize(svg))</div>"
    let style = "<style>svg{max-width:100%;height:auto}body{margin:16px}</style>"
    return "<!doctype html><html><head>\(cspTag)\(viewportTag)\(style)</head><body>\(body)</body></html>"
  }

  /// A Mermaid diagram rendered client-side by the bundled library (`mermaidLibrary`, inlined once). The
  /// diagram source travels as JSON in a script tag's data, never concatenated into script text.
  public static func html(fromMermaid source: String, mermaidLibrary: String, darkMode: Bool) -> String {
    let encoded = jsonStringLiteral(source)
    let theme = darkMode ? "dark" : "default"
    // The inlined library is trusted app code, so the policy here omits the https script allowance.
    let policy = contentSecurityPolicy.replacingOccurrences(
      of: "script-src 'unsafe-inline' 'unsafe-eval' https:", with: "script-src 'unsafe-inline' 'unsafe-eval'")
    return """
      <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="\(policy)">\(viewportTag)
      <style>body{margin:16px;display:flex;justify-content:center}svg{max-width:100%;height:auto}\
      #error{font:14px -apple-system,sans-serif;color:#b3261e;white-space:pre-wrap}</style></head>
      <body><div id="diagram"></div><div id="error"></div>
      <script>\(mermaidLibrary.replacingOccurrences(of: "</script", with: "<\\/script"))</script>
      <script>
      (async function () {
        try {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: '\(theme)' });
          const result = await mermaid.render('artifact-diagram', \(encoded));
          document.getElementById('diagram').innerHTML = result.svg;
        } catch (e) {
          document.getElementById('error').textContent = 'This diagram could not be drawn.';
        }
      })();
      </script></body></html>
      """
  }

  static func sanitize(_ source: String) -> String {
    var result = source
    for tag in strippedBlocks {
      result = result.replacingOccurrences(
        of: "<\(tag)\\b[\\s\\S]*?(</\(tag)\\s*>|$)", with: "", options: [.regularExpression, .caseInsensitive])
      result = result.replacingOccurrences(
        of: "<\(tag)\\b[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
    }
    for tag in strippedVoidTags {
      result = result.replacingOccurrences(
        of: "<\(tag)\\b[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
    }
    // A refresh redirect leaves the artifact; a page-supplied policy could loosen ours.
    result = result.replacingOccurrences(
      of: "<meta\\b[^>]*http-equiv\\s*=\\s*[\"']?(refresh|content-security-policy)[^>]*>", with: "",
      options: [.regularExpression, .caseInsensitive])
    return result
  }

  private static func jsonStringLiteral(_ text: String) -> String {
    guard let data = try? JSONEncoder().encode(text), let literal = String(data: data, encoding: .utf8) else {
      return "\"\""
    }
    // `</script` and U+2028/9 would end the script or the literal early.
    return literal.replacingOccurrences(of: "</", with: "<\\/")
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
  }
}
