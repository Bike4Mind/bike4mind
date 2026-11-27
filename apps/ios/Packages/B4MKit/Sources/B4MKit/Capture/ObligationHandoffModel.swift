import Foundation
import Observation

/// Drives "Hand to assistant" for a scanned document: upload it, have the assistant read the bill, then let
/// the user correct the amount, payee, due date and destination before confirming. A failed confirm keeps
/// every edit so the user can retry.
@MainActor
@Observable
public final class ObligationHandoffModel {
  public typealias Put = @Sendable (_ url: URL, _ data: Data, _ contentType: String) async throws -> Void

  public enum Phase: Equatable, Sendable {
    case uploading
    case extracting
    case reviewing
    case saving
    case done
    case failed(message: String)
  }

  public private(set) var phase: Phase = .uploading
  public private(set) var obligation: Obligation?
  /// Lakes the user can file into; built-in lakes are read-only and left out.
  public private(set) var lakes: [LakeSummary] = []
  /// Set when the last confirm failed; the edits are untouched.
  public private(set) var saveProblem: String?

  public var amountText = ""
  public var currency: String
  public var payee = ""
  public var dueDate: Date?
  public var destinationLakeID: String?

  private let file: URL
  private let text: String?
  private let api: any ObligationHandingOff
  private let destinations: any DestinationSource
  private let put: Put
  private let sleep: @Sendable (Duration) async throws -> Void
  private let maximumPolls: Int
  private let locale: Locale
  private let calendar: Calendar

  public init(
    file: URL, text: String?, api: any ObligationHandingOff, destinations: any DestinationSource, put: @escaping Put,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    maximumPolls: Int = 40, locale: Locale = .current, calendar: Calendar = .current
  ) {
    self.file = file
    self.text = text
    self.api = api
    self.destinations = destinations
    self.put = put
    self.sleep = sleep
    self.maximumPolls = maximumPolls
    self.locale = locale
    self.calendar = calendar
    currency = locale.currency?.identifier ?? "USD"
  }

  /// `.success(nil)` for an empty field, which clears the amount.
  public var parsedAmount: Result<Decimal?, AmountProblem> { Self.parseAmount(amountText, locale: locale) }

  public enum AmountProblem: Error, Equatable, Sendable { case notANumber, negative }

  public var canConfirm: Bool {
    guard phase == .reviewing, obligation != nil else { return false }
    if case .failure = parsedAmount { return false }
    return true
  }

  public func start() async {
    phase = .uploading
    do {
      let data = try Data(contentsOf: file)
      let ticket = try await api.createUpload(
        fileName: file.lastPathComponent, mimeType: "application/pdf", byteCount: data.count)
      try await put(ticket.uploadURL, data, "application/pdf")
      phase = .extracting
      let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
      let extracted = try await handOffWhenChecked(
        ticket.fileID, text: trimmed?.isEmpty == false ? trimmed.map { Self.capHandOffText($0) } : nil)
      lakes = ((try? await destinations.lakes()) ?? []).filter { !$0.isBuiltIn && $0.canManage }
      load(extracted)
      phase = .reviewing
    } catch {
      phase = .failed(message: Self.message(for: error))
    }
  }

  public func confirm() async {
    guard let obligation, case .success(let amount) = parsedAmount else { return }
    phase = .saving
    saveProblem = nil
    do {
      self.obligation = try await api.update(id: obligation.id, patch: patch(against: obligation, amount: amount))
      phase = .done
    } catch {
      saveProblem = Self.message(for: error)
      phase = .reviewing
    }
  }

  /// Only the fields the user changed, plus the confirmation.
  func patch(against original: Obligation, amount: Decimal?) -> ObligationPatch {
    var patch = ObligationPatch(status: "confirmed")
    let edited = amount.map { ObligationAmount(value: $0, currency: currency) }
    if edited != original.amount { patch.amount = .some(edited) }
    let name = payee.trimmingCharacters(in: .whitespacesAndNewlines)
    let editedPayee = name.isEmpty ? nil : name
    if editedPayee != original.payee { patch.payee = .some(editedPayee) }
    let day = dueDate.map(dayString)
    if day != original.dueDate { patch.dueDate = .some(day) }
    if destinationLakeID != original.destination?.lakeID { patch.destinationLakeID = .some(destinationLakeID) }
    return patch
  }

  private func handOffWhenChecked(_ fileID: String, text: String?) async throws -> Obligation {
    var attempt = 0
    while true {
      do {
        return try await api.handOff(fileID: fileID, text: text)
      } catch ObligationError.stillChecking where attempt < maximumPolls - 1 {
        attempt += 1
        try await sleep(.milliseconds(750))
      }
    }
  }

  private func load(_ extracted: Obligation) {
    obligation = extracted
    if let amount = extracted.amount {
      currency = amount.currency
      amountText = amount.value.formatted(.number.locale(locale).grouping(.never))
    }
    payee = extracted.payee ?? ""
    dueDate = extracted.dueDate.flatMap(date(fromDay:))
    destinationLakeID = extracted.destination?.lakeID
    if let destination = extracted.destination, !lakes.contains(where: { $0.id == destination.lakeID }) {
      lakes.insert(LakeSummary(id: destination.lakeID, name: destination.name, fileCount: 0, isBuiltIn: false), at: 0)
    }
  }

  /// The hand-off route refuses `text` over `OBLIGATION_LIMITS.text` (b4m-core/common schemas/obligation.ts),
  /// counted in UTF-16 units, so a long scan is cut there on a character boundary instead of failing.
  static let handOffTextLimit = 20_000

  static func capHandOffText(_ text: String, limit: Int = handOffTextLimit) -> String {
    guard text.utf16.count > limit else { return text }
    var units = 0
    var end = text.startIndex
    for index in text.indices {
      units += text[index].utf16.count
      if units > limit { break }
      end = text.index(after: index)
    }
    return String(text[..<end])
  }

  static func parseAmount(_ raw: String, locale: Locale) -> Result<Decimal?, AmountProblem> {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return .success(nil) }
    let formatter = NumberFormatter()
    formatter.locale = locale
    formatter.numberStyle = .decimal
    formatter.isLenient = false
    guard formatter.number(from: trimmed) != nil else { return .failure(.notANumber) }
    // NumberFormatter parses through Double (99.99 -> 99.98999...), so the exact value comes from the digits.
    let digits = trimmed.replacingOccurrences(of: formatter.groupingSeparator, with: "")
      .replacingOccurrences(of: formatter.decimalSeparator, with: ".")
    guard let value = Decimal(string: digits, locale: Locale(identifier: "en_US_POSIX")) else {
      return .failure(.notANumber)
    }
    return value < 0 ? .failure(.negative) : .success(value)
  }

  private func date(fromDay day: String) -> Date? {
    let parts = day.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
  }

  private func dayString(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  private static func message(for error: any Error) -> String {
    switch error {
    case ObligationError.rejected(let message): message
    case ObligationError.stillChecking: "The scan is still being checked. Please try again in a moment."
    case ObligationError.dismissed: "This bill was dismissed and can't be changed."
    case APIError.notFound: "The scan couldn't be found. Please scan it again."
    case APIError.offline: "You're offline. Please try again when you're connected."
    case APIError.rateLimited: "Too many requests. Please wait a moment and try again."
    default: "Something went wrong. Please try again."
    }
  }
}
