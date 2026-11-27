package com.bike4mind.kit.artifacts

import com.bike4mind.kit.environment.ServerEnvironment

/**
 * Builds the HTML a sandboxed WebView loads for an artifact. Artifact content is untrusted (it may be someone
 * else's, or model output), so the page carries a Content-Security-Policy that cuts network access and navigation,
 * and the markup is stripped of the tags that would work around it. The CSP is the guard; the stripping is defense
 * in depth, since a regex pass over HTML is never airtight. The WebView adds its own hardening (no file access, no
 * JS bridge, no storage, null origin): see the app's ArtifactWebView.
 */
object ArtifactDocuments {
    /** Where the bundled diagram renderer is "served" from; the WebView answers this host from its assets and fetches nothing else. */
    const val ASSET_HOST = "b4m-artifact-assets.invalid"
    const val MERMAID_SCRIPT_URL = "https://$ASSET_HOST/mermaid.min.js"

    private const val SCRIPT_HOSTS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com"

    // connect-src 'none' keeps a script from sending anything out; images may load from https, as pages embed photos.
    private val PAGE_POLICY = listOf(
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval' $SCRIPT_HOSTS",
        "style-src 'unsafe-inline' https://fonts.googleapis.com",
        "img-src data: blob: https:",
        "font-src data: https://fonts.gstatic.com",
        "media-src data: blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ).joinToString("; ")

    private val IMAGE_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

    private val DIAGRAM_POLICY = "default-src 'none'; script-src 'unsafe-inline' https://$ASSET_HOST; style-src 'unsafe-inline'; img-src data:; " +
        "font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"

    private const val VIEWPORT = """<meta name="viewport" content="width=device-width, initial-scale=1">"""

    private val STRIPPED_PAIRS = listOf("iframe", "object", "embed", "applet", "frameset", "frame").map {
        Regex("<$it\\b[^>]*>.*?</$it\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    }
    private val STRIPPED_SINGLES = listOf(
        Regex("<(?:iframe|object|embed|applet|frame|base)\\b[^>]*>", RegexOption.IGNORE_CASE),
        // A page's own policy or redirect must not replace ours.
        Regex("<meta\\b[^>]*\\bhttp-equiv\\b[^>]*>", RegexOption.IGNORE_CASE),
        Regex("<link\\b[^>]*\\brel\\s*=\\s*[\"']?(?:import|prefetch|preload|dns-prefetch|preconnect)[^>]*>", RegexOption.IGNORE_CASE),
    )

    private val HEAD_OPEN = Regex("<head\\b[^>]*>", RegexOption.IGNORE_CASE)
    private val HTML_OPEN = Regex("<html\\b[^>]*>", RegexOption.IGNORE_CASE)

    /** An interactive page: scripts run, but only the page's own and those from a few common CDNs, with no network calls. */
    fun page(content: String): String {
        var markup = content
        STRIPPED_PAIRS.forEach { markup = it.replace(markup, "") }
        STRIPPED_SINGLES.forEach { markup = it.replace(markup, "") }
        val guard = policyMeta(PAGE_POLICY) + VIEWPORT
        HEAD_OPEN.find(markup)?.let { return markup.replaceRange(it.range.last + 1, it.range.last + 1, guard) }
        HTML_OPEN.find(markup)?.let { return markup.replaceRange(it.range.last + 1, it.range.last + 1, "<head>$guard</head>") }
        return "<!doctype html><html><head>$guard</head><body>$markup</body></html>"
    }

    private val SCRIPT_BLOCK = Regex("<script\\b.*?</script\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val FOREIGN_BLOCK = Regex("<foreignObject\\b.*?</foreignObject\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val OPEN_ONLY = Regex("<(?:script|foreignObject)\\b[^>]*>", RegexOption.IGNORE_CASE)
    private val EVENT_ATTRIBUTE = Regex("\\son\\w+\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE)
    private val SCRIPT_URL = Regex("(href\\s*=\\s*[\"']?)\\s*javascript:[^\"'>\\s]*", RegexOption.IGNORE_CASE)
    private val PROLOG = Regex("<\\?xml[^>]*\\?>|<!DOCTYPE[^>]*>", RegexOption.IGNORE_CASE)

    /** A picture: scripts off entirely, so event handlers and script elements are stripped and would not run anyway. */
    fun svg(content: String): String {
        val clean = content
            .let { PROLOG.replace(it, "") }
            .let { SCRIPT_BLOCK.replace(it, "") }
            .let { FOREIGN_BLOCK.replace(it, "") }
            .let { OPEN_ONLY.replace(it, "") }
            .let { EVENT_ATTRIBUTE.replace(it, "") }
            .let { SCRIPT_URL.replace(it, "$1#") }
        return "<!doctype html><html><head>${policyMeta(IMAGE_POLICY)}$VIEWPORT" +
            "<style>html,body{margin:0;background:#fff}svg{max-width:100%;height:auto;display:block;margin:0 auto}</style>" +
            "</head><body>$clean</body></html>"
    }

    /** A diagram: the source is text inside a `<pre>`, drawn by the bundled renderer in its strict mode. */
    fun mermaid(source: String): String =
        "<!doctype html><html><head>${policyMeta(DIAGRAM_POLICY)}$VIEWPORT" +
            "<style>html,body{margin:0;background:#fff}pre.mermaid{margin:0;padding:16px;text-align:center}</style></head><body>" +
            "<pre class=\"mermaid\">${escape(source)}</pre>" +
            "<script src=\"$MERMAID_SCRIPT_URL\"></script>" +
            "<script>mermaid.initialize({startOnLoad:false,securityLevel:'strict'});mermaid.run({querySelector:'pre.mermaid'});</script>" +
            "</body></html>"

    private fun policyMeta(policy: String) = """<meta http-equiv="Content-Security-Policy" content="$policy">"""

    private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** The artifact in the web app, which draws every type at full fidelity. */
    fun fullVersionUrl(environment: ServerEnvironment, id: String): String = "${environment.baseUrl}/artifacts/$id"
}
