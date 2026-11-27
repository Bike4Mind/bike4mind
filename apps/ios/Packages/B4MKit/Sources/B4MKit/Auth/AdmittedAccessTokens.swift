import Foundation

/// An operation keeps the same admission across a refresh and its 401 recovery callbacks.
struct AdmittedAccessTokens: AccessTokenProviding {
  let tokens: any SharedSessionAdmissionProviding
  let admission: SharedSessionAdmission

  func accessToken() async throws -> String {
    try admission.withCurrent {}
    let token = try await tokens.accessToken()
    try admission.withCurrent {}
    guard AccountProfile.userID(fromAccessToken: token) == admission.identity.userID else {
      throw AuthError.signedOut
    }
    return token
  }

  func invalidateAccessToken(_ token: String) async {
    await tokens.invalidateAccessToken(token, admission: admission)
  }

  func sessionRejected() async {
    await tokens.sessionRejected(admission: admission)
  }
}
