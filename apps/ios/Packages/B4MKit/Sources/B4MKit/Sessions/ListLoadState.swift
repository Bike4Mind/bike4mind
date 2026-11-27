import Foundation

/// Where a list screen stands. Rows are kept separately from this so a failed refresh never blanks
/// content that is already on screen.
public enum ListLoadState: Equatable, Sendable {
  case idle
  case loading
  case loaded
  case failed(APIError)
}
