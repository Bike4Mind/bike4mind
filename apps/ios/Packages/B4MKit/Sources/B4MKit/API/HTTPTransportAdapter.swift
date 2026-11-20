import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Lets the generated client send through B4MKit's `HTTPTransport` seam, so one fake covers auth and API tests
/// and the app needs no second HTTP stack.
///
/// Bodies are buffered: every M2 response is a small JSON document. Streaming belongs to the realtime client.
struct HTTPTransportAdapter: ClientTransport {
  let transport: any HTTPTransport

  func send(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var urlRequest = URLRequest(url: try Self.url(for: request, baseURL: baseURL))
    urlRequest.httpMethod = request.method.rawValue
    for field in request.headerFields {
      urlRequest.addValue(field.value, forHTTPHeaderField: field.name.rawName)
    }
    if let body {
      urlRequest.httpBody = try await Data(collecting: body, upTo: Self.maxRequestBytes)
    }

    let (data, httpResponse) = try await transport.send(urlRequest)

    var response = HTTPResponse(status: .init(code: httpResponse.statusCode))
    for (name, value) in httpResponse.allHeaderFields {
      guard let name = name as? String, let value = value as? String, let fieldName = HTTPField.Name(name) else {
        continue
      }
      response.headerFields.append(HTTPField(name: fieldName, value: value))
    }
    return (response, data.isEmpty ? nil : HTTPBody(data))
  }

  private static let maxRequestBytes = 8 * 1024 * 1024

  private static func url(for request: HTTPRequest, baseURL: URL) throws -> URL {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw URLError(.badURL)
    }
    let path = request.path ?? "/"
    let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let basePath =
      components.percentEncodedPath.hasSuffix("/")
      ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
    components.percentEncodedPath = basePath + parts[0]
    components.percentEncodedQuery = parts.count > 1 ? String(parts[1]) : nil
    guard let url = components.url else { throw URLError(.badURL) }
    return url
  }
}
