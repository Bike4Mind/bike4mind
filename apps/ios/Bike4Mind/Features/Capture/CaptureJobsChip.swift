import B4MKit
import SwiftUI

/// A small chip for the Sessions toolbar, shown while a capture is uploading or has failed. Tapping it opens
/// the list of unfinished jobs. The owner keeps the `CaptureJobsViewModel` alive and observing, so the chip
/// can appear and disappear without losing the stream.
struct CaptureJobsChip: View {
  let model: CaptureJobsViewModel
  @State private var isShowingJobs = false

  var body: some View {
    Button {
      isShowingJobs = true
    } label: {
      HStack(spacing: Tokens.Spacing.xs) {
        if model.needsAttention {
          Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
        } else {
          ProgressView().controlSize(.mini).accessibilityHidden(true)
        }
        Text(model.chipTitle)
      }
      .font(Tokens.Typography.caption.weight(.semibold))
      .foregroundStyle(model.needsAttention ? Tokens.Palette.warning : Tokens.Palette.secondaryText)
    }
    .accessibilityHint("Shows uploads in progress")
    .accessibilityIdentifier("capture-jobs-chip")
    .sheet(isPresented: $isShowingJobs) {
      CaptureJobsList(model: model)
        .presentationDetents([.medium, .large])
    }
  }
}

private struct CaptureJobsList: View {
  let model: CaptureJobsViewModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        ForEach(model.rows) { row in
          CaptureJobRowView(row: row) { Task { await model.retry(row.id) } }
        }
      }
      .overlay {
        if model.rows.isEmpty {
          ContentUnavailableView("All caught up", systemImage: "checkmark.circle")
        }
      }
      .navigationTitle("Uploads")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
    }
    .accessibilityIdentifier("capture-jobs-list")
  }
}

private struct CaptureJobRowView: View {
  let row: CaptureJobRow
  let retry: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
      Text(row.name).font(.headline).lineLimit(2)
      Text("\(row.stageLabel) \u{00B7} \(row.destinationName)")
        .font(Tokens.Typography.caption)
        .foregroundStyle(row.stage == .failed ? Tokens.Palette.destructive : Tokens.Palette.secondaryText)
      if let detail = row.detail {
        Text(detail).font(Tokens.Typography.meta).foregroundStyle(Tokens.Palette.secondaryText)
      }
      if row.canRetry {
        Button("Retry", action: retry)
          .buttonStyle(.bordered)
          .frame(minHeight: 44)
          .accessibilityIdentifier("capture-job-retry-btn")
      }
    }
    .padding(.vertical, Tokens.Spacing.xs)
    .accessibilityElement(children: row.canRetry ? .contain : .combine)
  }
}
