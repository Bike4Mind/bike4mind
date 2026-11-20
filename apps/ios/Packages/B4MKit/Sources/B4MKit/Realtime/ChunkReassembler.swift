import Foundation

/// Rebuilds frames the server split into `_chunked` pieces. Mirrors the web client's reassembler
/// (apps/client/app/utils/wsChunkReassembler.ts): pieces are concatenated in index order and parsed
/// once complete.
///
/// A partial that cannot complete (a lost piece, a gateway hiccup) is dropped, never delivered and
/// never left to block later frames: streamed chat replies are cumulative, so the next complete frame
/// carries everything the lost one did.
struct ChunkReassembler {
  enum Outcome: Equatable {
    /// All pieces arrived; the reassembled JSON text.
    case complete(String)
    case pending
    /// The piece was refused, or its whole partial was discarded.
    case dropped(DropReason)
  }

  enum DropReason: Equatable {
    case tooManyParts
    case inconsistentTotal
  }

  static let ttl: TimeInterval = 30
  static let maxParts = 256
  /// Bounds memory if a misbehaving server opens partials it never finishes.
  static let maxPartials = 32

  private struct Partial {
    let total: Int
    let startedAt: Date
    var parts: [Int: String]
  }

  private var partials: [String: Partial] = [:]

  var pendingCount: Int { partials.count }

  mutating func accept(_ chunk: FrameChunk, at now: Date) -> Outcome {
    purgeExpired(at: now)

    guard chunk.total <= Self.maxParts else {
      partials[chunk.chunkID] = nil
      return .dropped(.tooManyParts)
    }

    var partial =
      partials[chunk.chunkID] ?? Partial(total: chunk.total, startedAt: now, parts: [:])
    guard partial.total == chunk.total else {
      partials[chunk.chunkID] = nil
      return .dropped(.inconsistentTotal)
    }
    partial.parts[chunk.index] = chunk.data

    guard partial.parts.count == partial.total else {
      if partials[chunk.chunkID] == nil, partials.count >= Self.maxPartials { evictOldest() }
      partials[chunk.chunkID] = partial
      return .pending
    }

    partials[chunk.chunkID] = nil
    let text = (0..<partial.total).compactMap { partial.parts[$0] }.joined()
    return .complete(text)
  }

  /// Drops partials older than the TTL. Called on every accepted piece and from the heartbeat, so an
  /// abandoned partial is released even if no further chunk ever arrives.
  mutating func purgeExpired(at now: Date) {
    partials = partials.filter { now.timeIntervalSince($0.value.startedAt) < Self.ttl }
  }

  private mutating func evictOldest() {
    guard let oldest = partials.min(by: { $0.value.startedAt < $1.value.startedAt })?.key else { return }
    partials[oldest] = nil
  }
}
