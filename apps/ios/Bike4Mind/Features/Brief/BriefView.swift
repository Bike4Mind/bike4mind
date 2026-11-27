import B4MKit
import SwiftUI

/// The assistant brief: a server-composed summary opened from a push or the drawer. What needs the user comes
/// first, because that is the point of it: approvals are answered and questions replied to right here.
struct BriefView: View {
  @Environment(AppServices.self) private var services
  let briefID: String?

  var body: some View {
    BriefScreen(
      api: services.briefs, pendingActions: services.pendingActions, followUps: services.briefFollowUps,
      briefID: briefID)
  }
}

private struct BriefScreen: View {
  @State private var model: BriefViewModel
  @Environment(AppServices.self) private var services
  @Environment(\.openURL) private var openURL
  @State private var editingFollowUp: BriefDecision?
  @State private var noMailApp = false

  init(api: any BriefAPI, pendingActions: any PendingActionAPI, followUps: any BriefFollowUpAPI, briefID: String?) {
    _model = State(
      initialValue: BriefViewModel(
        api: api, briefID: briefID, pendingActions: pendingActions, followUps: followUps))
  }

  var body: some View {
    content
      .background(Tokens.Palette.background)
      .navigationTitle("Brief")
      .navigationBarTitleDisplayMode(.inline)
      .task {
        await model.load()
        services.refreshWidgetPendingDecisions()
      }
      .onDisappear { model.cancel() }
      .sheet(item: $editingFollowUp) { decision in
        FollowUpEditSheet(
          decision: decision, failure: { model.followUpFailure(for: decision) },
          save: { edit in await model.editFollowUp(decision, edit) })
      }
      .alert("No mail app is set up on this device to send the draft.", isPresented: $noMailApp) {
        Button("OK", role: .cancel) {}
      }
      .refreshable {
        await model.refresh()
        services.refreshWidgetPendingDecisions()
      }
      // Voice triage answers through its own view model, so the cards refetch once voice mode closes.
      .onChange(of: services.navigator.voiceRequest) { old, new in
        if old != nil, new == nil { Task { await model.refresh() } }
      }
      .toolbar {
        if let brief = model.brief, brief.status == .ready {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Listen", systemImage: "waveform") {
              services.navigator.startVoiceConversation(.newConversation, briefID: brief.id)
            }
            .accessibilityIdentifier("brief-listen-btn")
          }
        }
        if let brief = model.brief, brief.status == .ready, !brief.isEmpty {
          ToolbarItem(placement: .topBarTrailing) {
            Button("New brief", systemImage: "arrow.clockwise") { model.startCompose() }
              .disabled(model.isComposing)
              .accessibilityIdentifier("brief-new-btn")
          }
        }
      }
  }

  @ViewBuilder
  private var content: some View {
    switch (model.state, model.brief) {
    case (.loading, nil):
      BriefSkeleton()
        .accessibilityIdentifier("brief-loading")
    case (.failed(let error), nil):
      ContentUnavailableView {
        Label("Couldn't load the brief", systemImage: "wifi.exclamationmark")
      } description: {
        Text(error.message)
      } actions: {
        Button("Try Again") { Task { await model.refresh() } }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("brief-retry-btn")
      }
    case (_, nil):
      ContentUnavailableView {
        Label("No brief yet", systemImage: "text.badge.checkmark")
      } description: {
        Text("Your assistant can summarize what happened, what it handled and what needs you.")
      } actions: {
        Button("Compose a brief") { model.startCompose() }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("brief-compose-btn")
      }
    case (_, let brief?):
      briefContent(brief)
    }
  }

  @ViewBuilder
  private func briefContent(_ brief: Brief) -> some View {
    switch brief.status {
    case .composing:
      composing
    case .failed:
      ContentUnavailableView {
        Label("The brief didn't finish", systemImage: "exclamationmark.triangle")
      } description: {
        Text("Something went wrong while putting it together.")
      } actions: {
        Button("Try Again") { model.startCompose() }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("brief-failed-retry-btn")
      }
    case .unknown:
      ContentUnavailableView(
        "Update to read this brief", systemImage: "arrow.down.app",
        description: Text("This brief needs a newer version of Bike4Mind."))
    case .ready:
      ready(brief)
    }
  }

  /// Scrollable so pull-to-refresh works here, with an explicit button for the same reason: a poll that timed
  /// out or failed must be recoverable without leaving the screen.
  private var composing: some View {
    ScrollView {
      VStack(spacing: Tokens.Spacing.m) {
        if case .failed(let error) = model.state {
          Label("Couldn't check on the brief", systemImage: "wifi.exclamationmark")
            .font(.headline)
          Text(error.message)
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .multilineTextAlignment(.center)
          checkAgainButton
        } else if model.composeTimedOut {
          Label("Still working on it", systemImage: "clock")
            .font(.headline)
          Text("This is taking longer than usual. Check again in a moment.")
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
            .multilineTextAlignment(.center)
          checkAgainButton
        } else {
          ProgressView("Putting your brief together")
        }
      }
      .padding(Tokens.Spacing.m)
      .frame(maxWidth: .infinity)
      .containerRelativeFrame(.vertical)
    }
    .accessibilityIdentifier("brief-composing")
  }

  private var checkAgainButton: some View {
    Button("Check again") { Task { await model.refresh() } }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("brief-check-again-btn")
  }

  @ViewBuilder
  private func ready(_ brief: Brief) -> some View {
    if brief.isEmpty {
      ContentUnavailableView {
        Label("All quiet", systemImage: "checkmark.circle")
      } description: {
        Text("Nothing needs you right now.")
      } actions: {
        Button("Compose a brief") { model.startCompose() }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("brief-compose-btn")
      }
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
          if case .failed(let error) = model.state {
            InlineErrorBanner(message: error.message) { Task { await model.refresh() } }
          }
          if let headline = brief.headline, !headline.isEmpty {
            Text(headline)
              .font(.title2.weight(.semibold))
              .foregroundStyle(Tokens.Palette.primaryText)
              .accessibilityAddTraits(.isHeader)
              .accessibilityIdentifier("brief-headline")
          }
          Text(periodText(brief))
            .font(Tokens.Typography.caption)
            .foregroundStyle(Tokens.Palette.secondaryText)
          decisionsSection(brief.decisions)
          itemsSection("Handled", items: brief.handled, id: "brief-handled-section")
          itemsSection("What happened", items: brief.happened, id: "brief-happened-section")
        }
        .padding(Tokens.Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .accessibilityIdentifier("brief-content")
    }
  }

  private func periodText(_ brief: Brief) -> String {
    let range = brief.periodStart.formatted(date: .abbreviated, time: .shortened)
    return "Since \(range)"
  }

  @ViewBuilder
  private func decisionsSection(_ decisions: [BriefDecision]) -> some View {
    if !decisions.isEmpty {
      section("What needs you", id: "brief-decisions-section") {
        ForEach(decisions) { decision in
          VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Text(decision.text)
              .font(Tokens.Typography.body)
              .foregroundStyle(Tokens.Palette.primaryText)
            if let approval = decision.approval {
              approvalControls(decision, approval)
              openConversationButton(decision, sessionID: approval.sessionID)
            } else if let question = decision.question {
              questionControls(decision, question)
              openConversationButton(decision, sessionID: question.sessionID)
            } else if let followUp = decision.followUp {
              followUpControls(decision, followUp)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(Tokens.Spacing.m)
          .background(Tokens.Palette.groupedBackground, in: RoundedRectangle(cornerRadius: Tokens.Radius.md))
          .accessibilityIdentifier("brief-decision-row")
        }
      }
    }
  }

  @ViewBuilder
  private func approvalControls(_ decision: BriefDecision, _ approval: BriefApprovalRef) -> some View {
    let local = model.approvalStates[decision.id]
    if approval.state == .pending, local?.offersDeny ?? true {
      if case .failed(let failure) = local {
        statusText(failure.message, id: "brief-decision-error")
      }
      HStack(spacing: Tokens.Spacing.s) {
        if local?.offersDecision ?? true {
          Button("Approve") { decide(decision, .approve) }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel("Approve: \(decision.text)")
            .accessibilityIdentifier("brief-approve-btn")
        }
        Button("Deny", role: .destructive) { decide(decision, .deny) }
          .buttonStyle(.bordered)
          .accessibilityLabel("Deny: \(decision.text)")
          .accessibilityIdentifier("brief-deny-btn")
      }
    } else if local?.isSubmitting == true {
      ProgressView()
        .accessibilityIdentifier("brief-decision-progress")
    } else {
      statusText(approvalLabel(approval.state, local: local), id: "brief-approval-state")
    }
  }

  private func approvalLabel(_ state: BriefApprovalState, local: ApprovalCardState?) -> String {
    switch state {
    case .pending:
      switch local {
      case .answered(let result): result.decision == .approve ? "Approved" : "Denied"
      case .failed(let failure): failure.message
      default: "Waiting for you"
      }
    case .approved: "Approved"
    case .denied: "Denied"
    case .replaced: "Replaced by a newer request"
    case .lapsed: "Lapsed before it was answered"
    case .resolved: "Answered"
    }
  }

  @ViewBuilder
  private func questionControls(_ decision: BriefDecision, _ question: BriefQuestionRef) -> some View {
    let local = model.replyStates[decision.id]
    let submitting = local == .submitting
    let failure = model.replyFailure(for: decision)
    if let failure {
      statusText(failure.message, id: "brief-reply-error")
    }
    if question.state == .open, local != .sent {
      if !question.options.isEmpty {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: Tokens.Spacing.s) { optionButtons(decision, question, disabled: submitting) }
          VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            optionButtons(decision, question, disabled: submitting)
          }
        }
      }
      HStack(spacing: Tokens.Spacing.s) {
        TextField("Reply", text: draftBinding(decision.id), axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("brief-reply-field")
        Button("Send") { send(decision) }
          .buttonStyle(.borderedProminent)
          .disabled(submitting || draft(decision.id).isEmpty)
          .accessibilityIdentifier("brief-reply-send-btn")
      }
    } else if failure == nil {
      statusText(questionLabel(question.state, sent: local == .sent), id: "brief-question-state")
    }
  }

  @ViewBuilder
  private func optionButtons(_ decision: BriefDecision, _ question: BriefQuestionRef, disabled: Bool) -> some View {
    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
      Button(option) { send(decision, text: option, choiceIndex: index) }
        .buttonStyle(.bordered)
        .disabled(disabled)
        .accessibilityIdentifier("brief-reply-option-btn-\(index)")
    }
  }

  private func questionLabel(_ state: BriefQuestionState, sent: Bool) -> String {
    if sent { return "Reply sent" }
    switch state {
    case .open: return "Waiting for you"
    case .answered: return "Answered"
    case .superseded: return "The conversation moved on"
    }
  }

  private func draft(_ id: String) -> String {
    (model.replyDrafts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func draftBinding(_ id: String) -> Binding<String> {
    let briefID = model.brief?.id
    return Binding(
      get: { model.brief?.id == briefID ? model.replyDrafts[id] ?? "" : "" },
      set: { model.setReplyDraft($0, decisionID: id, briefID: briefID) })
  }

  @ViewBuilder
  private func followUpControls(_ decision: BriefDecision, _ followUp: BriefFollowUpRef) -> some View {
    let local = model.followUpStates[decision.id]
    if let detail = followUpDetail(followUp) {
      statusText(detail, id: "brief-followup-kind")
    }
    if followUp.kind == .followUpEmail, let draft = decision.draftReply {
      VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
        Text("To: \(draft.to)")
        Text("Subject: \(draft.subject)")
        Text(draft.body).lineLimit(6)
      }
      .font(Tokens.Typography.caption)
      .foregroundStyle(Tokens.Palette.primaryText)
      .accessibilityIdentifier("brief-followup-draft")
    }
    if followUp.isActionable {
      if case .failed(let failure) = local {
        statusText(failure.message, id: "brief-followup-error")
      }
      if local == .submitting {
        ProgressView()
          .accessibilityIdentifier("brief-followup-progress")
      } else {
        HStack(spacing: Tokens.Spacing.s) {
          Button("Approve") { resolveFollowUp(decision, .approve) }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel("Approve: \(decision.text)")
            .accessibilityIdentifier("brief-followup-approve-btn")
          Button("Edit") { editingFollowUp = decision }
            .buttonStyle(.bordered)
            .accessibilityLabel("Edit: \(decision.text)")
            .accessibilityIdentifier("brief-followup-edit-btn")
          Button("Dismiss", role: .destructive) { resolveFollowUp(decision, .dismiss) }
            .buttonStyle(.bordered)
            .accessibilityLabel("Dismiss: \(decision.text)")
            .accessibilityIdentifier("brief-followup-dismiss-btn")
        }
      }
    } else {
      if let label = followUpStateLabel(followUp.state) {
        statusText(label, id: "brief-followup-state")
      }
      // Approval is recorded before the mail handoff, so a draft the mail app never opened can still be sent.
      if followUp.kind == .followUpEmail, followUp.state == .approved, let url = decision.draftReply?.mailtoURL {
        Button("Open in Mail") { openMail(url) }
          .buttonStyle(.bordered)
          .accessibilityLabel("Open in Mail: \(decision.text)")
          .accessibilityIdentifier("brief-followup-open-mail-btn")
      }
    }
  }

  private func followUpDetail(_ followUp: BriefFollowUpRef) -> String? {
    switch followUp.kind {
    case .actionItem: "Action item"
    case .followUpEmail: "Follow-up email"
    case .reminder:
      followUp.remindAt.map { "Reminder, \($0.formatted(date: .abbreviated, time: .shortened))" }
        ?? "Reminder, no time set yet"
    case .unknown: nil
    }
  }

  private func followUpStateLabel(_ state: BriefFollowUpState) -> String? {
    switch state {
    case .approved: "Approved"
    case .dismissed: "Dismissed"
    case .pending, .unknown: nil
    }
  }

  private func resolveFollowUp(_ decision: BriefDecision, _ outcome: BriefDecisionOutcome) {
    let briefID = model.brief?.id
    Task {
      guard model.brief?.id == briefID else { return }
      if let draft = await model.resolveFollowUp(decision, outcome), let url = draft.mailtoURL {
        openMail(url)
      }
    }
  }

  private func openMail(_ url: URL) {
    openURL(url) { accepted in
      if !accepted { noMailApp = true }
    }
  }

  private func decide(_ decision: BriefDecision, _ answer: PendingActionDecision) {
    let briefID = model.brief?.id
    Task {
      guard model.brief?.id == briefID else { return }
      await model.decide(decision, answer)
    }
  }

  private func send(_ decision: BriefDecision, text: String? = nil, choiceIndex: Int? = nil) {
    let text = text ?? draft(decision.id)
    let briefID = model.brief?.id
    Task {
      guard model.brief?.id == briefID else { return }
      await model.reply(decision, text: text, choiceIndex: choiceIndex)
    }
  }

  private func statusText(_ text: String, id: String) -> some View {
    Text(text)
      .font(Tokens.Typography.caption)
      .foregroundStyle(Tokens.Palette.secondaryText)
      .accessibilityIdentifier(id)
  }

  private func openConversationButton(_ decision: BriefDecision, sessionID: String) -> some View {
    Button("Open conversation") { services.navigator.pushSession(id: sessionID) }
      .buttonStyle(.bordered)
      .accessibilityLabel("Open conversation: \(decision.text)")
      .accessibilityIdentifier("brief-open-conversation-btn")
  }

  @ViewBuilder
  private func itemsSection(_ title: String, items: [BriefItem], id: String) -> some View {
    if !items.isEmpty {
      section(title, id: id) {
        ForEach(items) { item in
          Text(item.text)
            .font(Tokens.Typography.body)
            .foregroundStyle(Tokens.Palette.primaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("brief-item-row")
        }
      }
    }
  }

  private func section<Content: View>(
    _ title: String, id: String, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
      Text(title)
        .font(.headline)
        .foregroundStyle(Tokens.Palette.primaryText)
        .accessibilityAddTraits(.isHeader)
      content()
    }
    .accessibilityIdentifier(id)
  }
}

/// Mirrors the loaded brief: a headline and period line, then titled sections of rows.
private struct BriefSkeleton: View {
  private static let rowFractions: [[CGFloat]] = [[0.9, 0.75], [0.85, 0.6, 0.7], [0.8, 0.65]]

  var body: some View {
    SkeletonContainer(label: "Loading brief") {
      VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
          SkeletonBlock(widthFraction: 0.75, height: 24)
          SkeletonBlock(widthFraction: 0.35, height: 12)
        }
        ForEach(Self.rowFractions.indices, id: \.self) { section in
          VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            SkeletonBlock(widthFraction: 0.4, height: 17)
            ForEach(Self.rowFractions[section].indices, id: \.self) { row in
              SkeletonBlock(widthFraction: Self.rowFractions[section][row])
            }
          }
        }
      }
      .padding(Tokens.Spacing.m)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
}
