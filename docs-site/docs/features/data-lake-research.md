---
title: Data Lake Research
description: Set up research runs that find new sources for a data lake, review what they propose, and undo changes from the lake's History.
sidebar_position: 18
---

# Data Lake Research

A research run looks for new material for one data lake. It searches the web, or reads a feed, with the settings you save. It puts what it finds in the lake's review queue.

Nothing is added because of a relevance score. A person approves each proposal, unless it comes from a site you marked as trusted and turned on automatic adding for.

You need manage rights on the lake to use any of this. A member who can only read a lake does not see the Research, Proposals or History tabs.

To drive research from code or from an AI assistant, see [Automate lake research](../api/automate-lake-research.md).

## Where research lives

Open the Data Lakes manager and select a lake. The lake info panel shows these controls to lake managers:

- **Research** opens the lake's settings on the **Research** tab.
- **Settings** opens the same dialog on the **Settings** tab.
- **N sources to review** appears while proposals are waiting. It opens the **Proposals** tab.

The settings dialog has the tabs Settings, Spend, History, Proposals and Research. The Proposals tab shows the number of waiting proposals, for example **Proposals (7)**.

## Set up your first configuration

A configuration is a saved set of research settings. A lake can hold up to 20.

1. Open the **Research** tab and choose **New configuration**.
2. Enter a **Name**. Names are limited to 120 characters.
3. Leave **Source** on **Web search**, or choose **Feed** to read an RSS or Atom feed. A feed adds a **Feed address** field.
4. Describe **What to look for**, up to 500 characters. For a feed, the field is called **Topic**. A search uses this text as the web search and as the question each result is judged against.
5. Pick a **Schedule**: **Off (Run now only)**, **Daily**, **Weekly** or **Monthly**.
6. Pick a depth under **Depth and cost**: **Quick**, **Standard** or **Deep**. The line under the buttons shows the judge model, the number of results and proposals, and the cost ceiling for that choice.
7. Choose **Save configuration**.

Save stays disabled until you add a name and what to look for. The form says "Add a name and what to look for to save."

Choose **Run now** on the saved configuration to start a run. Run now always works, whatever the schedule says. While one run is active in the lake, the other cards show **Another run in progress**.

### Advanced settings

Choose **Advanced settings** to change the details.

| Setting | What it does |
| --- | --- |
| **Relevance model** | The model that judges each result. A cheaper model costs less per run and reads less carefully. |
| **Search results** | How many results one run looks at, from 1 to 50. For a feed it is **Feed items per run**. |
| **Proposals per run** | The most proposals one run adds to the queue, from 1 to 25. |
| **Only results from the last** | A recency limit in days, up to 366. Leave it blank for any age. |
| **Minimum relevance** | A percent from 0 to 100. Below this, a result is never fetched or proposed. |
| **Cost ceiling** | The most one run spends on judging. See [Cost](#cost). |
| **Hold scheduled runs at** | Shown when a schedule is on. See [Schedules](#schedules-pause-and-held). |
| **Item rules** | Plain-language conditions that block an item or send it to review. |
| **Tags to propose** | Suggested tags shown on each proposal. Approving applies the lake tag, not these. |

### Which sites to use

The **Which sites to use** group decides what happens to a result based on its site. Enter one site per line. A site entry includes its subdomains.

- **Trusted sites**: list only sites whose content you control or vouch for. Never list a host where anyone can publish, such as a blogging platform, a code-hosting site or a shared file host.
- **Add trusted results automatically**: a switch under the trusted list. It stays off until you list a trusted site. When on, a first-time result from a trusted site joins the lake without your approval. Anything you declined before, and every other site, still waits for review. **Added automatically per run** caps how many a run adds, and the proposal limit applies as well.
- **Sites to review**: results from these sites go to the review queue. The list only narrows results when **Other sites** is set to ignore.
- **Never these sites**: results from these sites are dropped. This list wins over every other setting.
- **Other sites**: what happens to a result from a site on none of the lists. Choose **Send to review** or **Ignore**. If you choose **Ignore**, list at least one site to review, or the form refuses to save with "List at least one site to review, or send other sites to review."

Turning automatic adding off, or removing a trusted site, stops a run already in progress from adding more. Turning it on, adding sites or changing the limit applies from the next run. Each automatic addition is marked in the lake's History and on the source itself.

### Item rules

An item rule is a short condition, for example "the author works for a named company". Each rule either **Block**s the item or sends it to review (**Send to review**). A model checks every rule against the item's feed fields and the text of its page.

A rule can never add anything. It never removes content that is already in the lake. A rule that cannot be checked never blocks an item and never adds one. If the item would otherwise be added automatically, it goes to review instead.

You can have up to 10 rules, each up to 300 characters. Rule checks use the relevance model, so they count toward the cost ceiling. Rules apply from the next run.

Review rules are a convenience for ordinary content. They are not a control against an author who writes a page to fool the checker. If anyone can post on a site, do not turn on automatic adding for it.

### Reading a feed

With **Source** set to **Feed**, each run considers only items it has not seen before. A feed that publishes more items than **Feed items per run** allows falls behind, and the run card shows how many items are waiting.

Changing the topic, the model, the relevance threshold or any site list re-checks the newest items under the new settings. Items still waiting in the queue stay there. Changing the feed address starts fresh from the newest items.

## Schedules, pause and held

A schedule runs the configuration **Daily**, **Weekly** or **Monthly**. The card shows a line such as "Runs weekly. Next run: Tue 3 Dec. Held while 25 or more proposals are waiting."

- **Pause schedule** stops scheduled runs and keeps the schedule. The card reads "Paused. Runs weekly when resumed." **Resume schedule** starts it again on the same schedule. **Run now** still works while paused.
- **Held** means the schedule is waiting for you. The card says "Held: 30 proposals are waiting. Scheduled runs resume when fewer than 25 are waiting." A **Review proposals** link opens the Proposals tab.
- **Hold scheduled runs at** sets the number. The default is 25, and the largest value is 500. **Run now** is never blocked by it. The card warns you when a run you start will add to a long queue.
- When the scheduler skips a due run for another reason, the card says why and that it will retry in about an hour. The reasons are another run in progress, the daily run limit, too few credits for the lake owner, an inactive lake, or paused spending for the lake owner.
- When scheduled runs fail, the card shows how many failed in a row and the latest reason.

## Cost

Each run spends credits on relevance judgments. The **Cost ceiling** field says: "Judgement spend for one run, paid from the lake owner's credits (their organization's pool if they belong to one)." The run stops when it would exceed the ceiling.

- The ceiling can be set from a fraction of a cent up to $5.00. **Quick** uses $0.05, **Standard** $0.25 and **Deep** $1.00.
- With a schedule on, the form shows "Roughly up to $X a month at this schedule." It multiplies the ceiling by 31 runs for daily, 5 for weekly and 1 for monthly. It is an upper bound.
- Approving a proposal also costs indexing, because the page is fetched and added to the lake like any other file. Indexing is separate from the ceiling.
- A run is refused when the lake owner's credits cannot cover its ceiling.

Each run card shows what that run spent.

## Reading a run

Recent runs are listed on the Research tab. Each shows a status chip: **Queued**, **Running**, **Finished**, **Stopped early**, **Failed** or **Did not finish**. A run that stopped at a limit reads **Stopped early**. **Did not finish** marks a run that stopped without settling.

The summary line counts where the results went. It lists only the counts that are not zero. For example: "9 found . 5 proposed . 1 below the relevance floor . 2 could not be fetched". Every result lands in exactly one outcome.

| The run says | What happened | What changes it |
| --- | --- | --- |
| **found** | Results the search returned. For a feed, **new item** counts the new items. | **Search results** |
| **proposed** | Results that reached the review queue. | **Proposals per run** |
| **added automatically** | Part of proposed. Trusted results the run added without a reviewer. | **Added automatically per run** |
| **trusted, not added automatically** | Part of proposed. Trusted results the rule tried but did not add. | Nothing to change. They wait for review. |
| **sent to review by a rule** | Part of proposed. A review rule took them out of automatic adding. | **Item rules** |
| **on your Never these sites list** | From a site on the never list, or with no usable web address. | **Never these sites** |
| **from sites not on your lists (Other sites: Ignore)** | From a site on none of your lists, which are ignored. | **Other sites** |
| **search link never revealed its site** | A search link that hid its site. Skipped. It usually clears on the next run. | Nothing. Run again. |
| **blocked by an item rule** | A rule with the Block action removed it. | **Item rules** |
| **below the relevance floor** | The judge scored it below the minimum. | Lower **Minimum relevance** to keep more. |
| **could not be judged (the model call failed)** | The judge failed on it. | Nothing. Try the run again. |
| **already in the lake** | The lake already holds it. | Nothing. |
| **already awaiting review** | A proposal for this source is already waiting. | Nothing. |
| **previously declined** | You declined it before and it has not changed. | Nothing. |
| **unusable source** | It has no usable web address. | Nothing. |
| **could not be fetched** | The page could not be fetched or read. | Nothing. |
| **not judged (the judge was unavailable, so the run stopped)** | The run stopped before scoring these. | Nothing. Try the run again later. |

Under the summary, the run can show a hint for its largest group of dropped results. It names the setting and the value the run used, for example "Check Other sites (Ignore) in Advanced settings." The hint appears only when a setting applies. **Adjust settings** opens the run's configuration with Advanced settings open and the setting in focus.

A run that stopped early shows why:

- "Stopped at the cost ceiling for one run. Raise Cost ceiling in Advanced settings to check more."
- "Reached the proposals limit for one run. Raise Proposals per run in Advanced settings to see more."
- "Stopped at the time limit for one run. The rest are checked next run."
- "Stopped because the relevance judge was unavailable. No setting applies. Try again later."
- "Went through every search result" (or "Went through every new feed item") means the run looked at everything it found.

## Review proposals

Open the **Proposals** tab. **Waiting for review** shows the queue and **Declined** shows what you declined. You can sort by **Most relevant first** or **Newest first**.

Each proposal shows its title, the relevance as a percent, why it was proposed, which run found it, and an excerpt. A **Previously declined** chip marks a source that came back changed. The excerpt comes from a page nobody has vetted, so read the source before you approve.

- **Approve and add** fetches the page now and adds it to the lake. It is chunked like any other file and tagged with the lake tag only. Suggested tags are not applied.
- **Decline** asks for an optional reason. A decline is remembered, so the same source is not proposed again unless its content changes.
- **Restore to queue** (on the Declined view) puts a declined proposal back in the queue. The excerpt is not kept after a decline, so open the source to judge it again.

## History and Undo

Every change to research settings and proposals is recorded in the lake's **History** tab. A row shows when the change happened, who made it, how they were authorized, and what changed. Settings changes name the setting and show the old and new value. Approvals, declines and automatic additions are recorded too.

File additions and removals are kept for 450 days. Older file changes are not shown. The tab says when the list is cut short.

Only lake managers can see History. A member with read access cannot.

There are no approval prompts. A change applies when you make it, and History is where you reverse it.

An **Undo** button appears on a row when the change can be reversed. Undoing is itself recorded in History. A row you undid shows **Undone** instead of the button, and a change can be undone once.

You can undo:

- a change to a configuration's settings
- creating a configuration, while it still exists
- deleting a configuration, for 30 days after the delete
- approving a proposal, which removes the file the approval added
- declining a proposal, which puts it back in the queue
- restoring a proposal, which declines it again
- adding a file to the lake
- removing a file from the lake, for 30 minutes after the removal

Some rows have no button and show a note instead:

- "Re-approve from Proposals" on a restore that came from an unapprove.
- "Delete it from Research" on a configuration that was recreated by an undo.
- "This change is too old to undo" on a delete older than 30 days.
- "Add it again from your files" on a file removal older than 30 minutes.

An undo can be refused. The row shows the reason:

- "A later change touched the same item, so this one cannot be undone."
- "A later change touched the same file, so this one cannot be undone."
- "The approved file was added or removed after this approval, so it cannot be undone."
- A message that names the setting when its value changed since this edit, or when the old value no longer passes today's checks.
- "This research configuration no longer exists."
- "Already undone."

After a refusal that names a setting, fix that setting and try again.
