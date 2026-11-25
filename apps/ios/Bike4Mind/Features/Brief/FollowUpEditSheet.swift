import B4MKit
import SwiftUI

/// Edits a pending follow-up before it is approved: its text, an email's draft, or a reminder's time. A failed save
/// keeps the form open with the user's changes.
struct FollowUpEditSheet: View {
  let decision: BriefDecision
  let failure: () -> BriefDecisionFailure?
  let save: (BriefDecisionEdit) async -> Bool

  @Environment(\.dismiss) private var dismiss
  @State private var text: String
  @State private var to: String
  @State private var subject: String
  @State private var emailBody: String
  @State private var remindAt: Date
  /// A reminder with no time starts the picker an hour out, but that default is only sent once the user picks.
  private let initialRemindAt: Date
  @State private var isSaving = false

  init(
    decision: BriefDecision, failure: @escaping () -> BriefDecisionFailure?,
    save: @escaping (BriefDecisionEdit) async -> Bool
  ) {
    self.decision = decision
    self.failure = failure
    self.save = save
    _text = State(initialValue: decision.text)
    _to = State(initialValue: decision.draftReply?.to ?? "")
    _subject = State(initialValue: decision.draftReply?.subject ?? "")
    _emailBody = State(initialValue: decision.draftReply?.body ?? "")
    initialRemindAt = decision.followUp?.remindAt ?? Date().addingTimeInterval(3600)
    _remindAt = State(initialValue: initialRemindAt)
  }

  private var kind: BriefFollowUpKind? { decision.followUp?.kind }

  var body: some View {
    NavigationStack {
      Form {
        Section("Follow-up") {
          TextField("Text", text: $text, axis: .vertical)
            .accessibilityIdentifier("followup-edit-text")
        }
        if kind == .followUpEmail {
          Section("Email") {
            TextField("To", text: $to)
              .textContentType(.emailAddress)
              .keyboardType(.emailAddress)
              .textInputAutocapitalization(.never)
              .accessibilityIdentifier("followup-edit-to")
            TextField("Subject", text: $subject)
              .accessibilityIdentifier("followup-edit-subject")
            TextField("Message", text: $emailBody, axis: .vertical)
              .lineLimit(4...12)
              .accessibilityIdentifier("followup-edit-body")
          }
        }
        if kind == .reminder {
          Section("Remind me") {
            DatePicker("When", selection: $remindAt, in: Date()...)
              .accessibilityIdentifier("followup-edit-remind-at")
          }
        }
        if let failure = failure() {
          Text(failure.message)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .accessibilityIdentifier("followup-edit-error")
        }
      }
      .navigationTitle("Edit follow-up")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .accessibilityIdentifier("followup-edit-cancel-btn")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { submit() }
            .disabled(isSaving || edit.isEmpty || !isComplete)
            .accessibilityIdentifier("followup-edit-save-btn")
        }
      }
    }
  }

  /// Only the fields the user changed, so an unchanged draft is never re-sent.
  private var edit: BriefDecisionEdit {
    BriefDecisionEdit(
      changing: decision, kind: kind, text: text, draft: BriefDraftReply(to: to, subject: subject, body: emailBody),
      remindAt: remindAt, initialRemindAt: initialRemindAt)
  }

  private var isComplete: Bool {
    let edit = edit
    if let text = edit.text, text.isEmpty { return false }
    if let draft = edit.draftReply, draft.to.isEmpty || draft.subject.isEmpty || draft.body.isEmpty { return false }
    return true
  }

  private func submit() {
    isSaving = true
    Task {
      let saved = await save(edit)
      isSaving = false
      if saved { dismiss() }
    }
  }
}
