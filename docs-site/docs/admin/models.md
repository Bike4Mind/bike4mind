---
title: Models
description: Control which AI models users can pick, see why a model is hidden, set provider prices, and run model discovery
sidebar_position: 16
tags: [admin, llm, models, ai]
---

# Models

The Models page is in the AI section of the admin sidebar. It lists every model the platform knows, shows who can pick each one and why a model is hidden, and holds the provider prices billing reads. The page has four sections, chosen from the tabs under the header: **Models**, **Prices**, **Discovery**, and **Settings**. The header also has a **Run discovery** button that starts a discovery run.

Only full administrators can change models. A delegated admin with the `support:read` permission can open the page and sees the same data, and every write button is disabled with a tooltip that says so. The lifecycle suggestions on the Discovery section also need `settings:manage`; without it that part shows the missing permission instead.

## Models

The Models section is the model list. The section, view, search, filters, sort, and page are kept in the page URL, so you can bookmark or share a filtered list.

### Views

| View | Shows |
| --- | --- |
| Needs review | Models waiting for a decision: no price, a price only quoted by an aggregator, waiting for a discovery run, waiting for approval, or a pending lifecycle suggestion |
| All | Every model |
| Listed | Models users can pick, including Limited ones |
| Hidden | Models with the Hidden status: no user can pick them, for a reason other than a pending review or retirement |
| Retiring | Models deprecated, retired, or with a deprecation or retirement date that has passed or falls within 90 days |

Each view shows its count. A model can be in more than one view, for example a hidden model that retires within 90 days is in both **Hidden** and **Retiring**, so the counts do not add up to **All**. The page opens on **Needs review** while it holds any model, and on **All** otherwise.

### Search and filters

- **Search name or id** matches the model name or id
- **Provider**, **Type**, and **Source** filter chips narrow the list. Source is **Default** (built in), **Discovered** (found by model discovery), or **Set by admin**
- Bedrock foundation ids are hidden by default. A link above the table says how many are hidden; select it to show them

When nothing matches, the table says so and offers to clear the filters.

### Columns

| Column | Sortable | Description |
| --- | --- | --- |
| Model | Yes | Display name and model id, with a button to copy the id |
| Type | Yes | Text, Image, Video, Music, Embedding, Speech to text, Text to speech, and others |
| Status | Yes | The model's status and the reasons behind it, with a fix action when there is one |
| Retires | Yes | The sooner of the model's deprecation and retirement dates, with the days left or how long ago it passed, counted in UTC calendar days (**today** on the date itself). A dash when neither date is set |
| Rank | Yes | Picker order, lower first. **Provisional** means no admin or catalog rank is set yet; **Unranked** means the picker does not offer it |
| Price /1M in/out | No | Provider cost per 1M input and output tokens, or per image or minute for other units |
| Access | No | Who can pick the model: **Everyone**, the entitlements and tag count that allow it, **Off**, or **Admins only** |

Select a column header to sort by it; select it again to reverse the order. Sorting by **Retires** puts the most overdue model first and models with no date last. The **Retiring** view opens sorted that way. Select a row to open the model's detail page. Each row also has a menu to open the model or turn it on or off.

### Statuses

| Status | Meaning |
| --- | --- |
| Listed | Users can pick it |
| Limited | Users can pick it, but only some of them: access is restricted to tags or entitlements, or the free tier is locked out |
| Needs review | It waits for a decision before users can pick it |
| Hidden | No user can pick it. The reason is shown, for example the model is turned off or its provider has no API key configured |
| Retiring | Its lifecycle status is deprecated or retired, or the earlier of its deprecation date and retirement date is within 90 days or already passed. A model still served after its retirement date, with no deprecation date that has arrived, shows as Retiring. It does not apply to a model that is Retired, Hidden or Needs review |
| Retired | Its deprecation date is today or earlier (UTC), or its provider has retired it and no catalog override set outside this console disables it, or this deployment does not serve it and its lifecycle status is legacy, deprecated or retired. A passed retirement date alone does not make it Retired. Retired takes precedence over every other status |

A fix action next to the reason takes you to the change that resolves it: **Turn on**, **Add price**, **Run discovery**, **Review suggestion**, or **Open key settings**.

**Admins only** in the Access column means the model is turned on but has no tags and no entitlements, so no user can pick it. Admins can always pick every model that is turned on.

### Bulk access changes

Use the checkbox at the start of each row to select models. The header checkbox selects every row on the page, and **Select all N matching** then selects every model that matches the current view, search, and filters, across pages. A bar shows how many models are selected and offers:

- **Turn on** and **Turn off**
- **Add tag** and **Remove tag**
- **Add entitlement** and **Remove entitlement**

Each opens a dialog that previews the change on the server before anything is written:

- How many models change and how many already match, with the changed models in an expandable list showing each model's before and after
- The effect on each model's audience: whether it reaches fewer users, more users, or the same users afterwards
- When you add a tag to models that are still open to everyone through the `base` entitlement, the tag changes nobody's access, so the dialog says so and offers **Also remove base**
- Any model the change would leave visible only to admins, listed separately with a confirmation you must check
- A required reason, recorded in each model's admin log

If another admin changes the selected models after the preview, the dialog shows a fresh preview instead of applying the old one. After the change is applied, a summary reports what changed. Models that could not be changed are listed with **Retry failed**. A toast offers **Undo**, which reverts the whole batch, including any models changed by **Retry failed**. If some models changed again before you undo, Undo reverts the others and lists the ones it skipped, each linked to its model page with the reason. Change those back from each model's page.

## Model detail

The detail page shows the model's name, id, status, type, backend, and release date, with a breadcrumb back to the list. The line under the name links to **Usage** and **Logs**, which open [Model Metrics](./metrics.md) and [Model Logs](./model-logs.md) filtered to this model, and the header offers **Turn on** or **Turn off**. A strip under the header shows the model's rank, price, access, and fallback.

The page has three tabs:

| Tab | Contents |
| --- | --- |
| Overview | Identity, presentation, limits and price, and lifecycle, read-only |
| Access | Three groups: **Availability** (whether the model is on, who can pick it, and its free-tier state, with **Turn on** or **Turn off**), **Tags and entitlements**, and **Rank and fallback**, each with **Edit** |
| Admin log | Every admin action on the model: who made it, when, and the reason |

### Changing one model's access

Turning a model on or off, and editing its tags, entitlements, rank, or fallback, opens a dialog that shows the value before and after the change and asks for a reason. A user can pick a model that is turned on when they hold any one of its tags or entitlements. The tag picker suggests every tag users hold, plus tags already set on other models. If the change would leave the model visible only to admins, you must confirm that first.

Changes apply right away and are recorded in the Admin log. A toast offers **Undo**. If another admin changed the model after you opened it, the change is refused and you are asked to reload. Open model pickers drop or add the model within about 15 seconds.

The fallback model is used when a request to this model fails at the provider. **Automatic** means no fallback is set and the platform's built-in fallback order applies. The picker offers listed and limited models of the same type. A saved fallback outside those still shows, with its status, so you can see it and replace it.

## Prices

The Prices section is the versioned model price catalog. **Rates are provider costs in USD, shown per 1M tokens, not credit prices.** What a user pays is always this cost multiplied by the platform's published markup, so this section manages cost data and never markup.

Each row shows the price in force for one model: input and output rates, audio rates for realtime voice models, the date it took effect, and a source chip:

| Source | Meaning |
| --- | --- |
| Default | Shipped in the built-in model tables and managed automatically |
| Discovered | Read from a provider price feed by model discovery |
| Set by admin | Saved by an admin here |

The filter box narrows the table to matching model ids; a full model id shows only that model.

| Action | Description |
| --- | --- |
| **Add price** | Adds the first price row for a model that has none. Offered for text models without a price row and for realtime voice models priced by the built-in tables. Enter rates per 1M tokens, with optional extra tiers that start at a token count, and a reason. At least one input or output rate must be above 0 |
| **Reprice** | Appends a new operator price row that takes effect immediately. Requires a note saying where the price comes from, such as an invoice or a provider pricing page. While an operator row is newest, automatic seed updates skip that model |
| **History** | Shows every price the model has had as a change log: who made each change, the note, and the old and new rate for every field that changed. Rows are never edited, so the history is complete |
| **Revert** | Offered on rows set by an admin or by discovery, for models the built-in tables price. Appends the built-in table's current rates back under automatic management, so future automatic price updates reach the model again. The earlier row stays in history |

Price rows bill text and realtime voice models only, so other model types offer no price changes here. A realtime voice price needs input, output, audio in, and audio out rates above 0 on its lowest tier; the dialog holds the change until they are entered. Both dialogs show what a user pays at the published markup. A rate far from the current price is refused with the reason, and **Apply anyway** lets you confirm it.

## Discovery

Model discovery checks the providers for new models, price changes, and retirements. The Discovery section shows:

- **Discovery runs**: recent runs with when each started, what triggered it, its result, and a summary of what it found. Select a run to open its page
- **Lifecycle suggestions**: deprecations, retirements, and replacements discovery suggests. **Accept change** applies one, with a successor model you choose, and says when the model leaves the pickers. **Dismiss suggestion** dismisses it for good: you type the model id to confirm, and discovery does not raise it again while the provider's signal is unchanged. **Model prices** opens the Prices section
- **References to unavailable models**: settings and defaults that still name a model users can no longer pick. **Check references** asks every provider and shows the result; nothing is checked until you ask

When discovery is off, the section says so and offers **Open settings**. **Run discovery** in the page header starts a run now; a toast links to the run when it finishes, and the list and prices refresh.

### Run page

A run's page shows what the run changed, grouped as **Added**, **Listed**, **Repriced**, **Lifecycle changes**, and **Overruled sources**. A run in report-only mode shows the same groups as **Would add**, **Would list**, and **Would reprice**. Models from the run that still need a decision are listed with their reasons, their fix actions, and **Open model**. Runs are kept for 90 days.

## Settings

The Settings section holds the model settings that used to live on the general Settings page. Edits are staged and saved together, as on the [Admin Settings](./admin-settings.md) page.

| Group | Settings |
| --- | --- |
| Discovery | Whether discovery runs, whether it may contact provider sources, **Discovery mode** (Report only or Writes changes), **New-model policy** (when a newly found model is listed), the price band (the largest price change discovery applies without review), **Replacement for retired models** (suggest or apply), and whether new models are probed for the tool support they take |
| Defaults | The default model, the recommended models pinned in the picker, and the operations models used for background work |
| Free tier | Whether the free-tier model gate is on, its **Gate scope** (all models or media models only), and the models free accounts may call |
| Generation | One switch per video and music model, controlling whether users can start jobs with it |

## Best practices

- Work through **Needs review** first: it lists every model waiting for a price, an approval, or a lifecycle decision
- Turn a model off before removing its provider key, so users are not offered a model that fails
- Use tags and entitlements to control access to expensive models, and check the audience effect in the preview before applying a bulk change
- Write reasons that say why, not what: the Admin log already records what changed
- Set a fallback for models your users depend on

## Related Articles

- [Admin Settings](./admin-settings.md)
- [Credit Analytics](./credit-analytics.md)
- [Model Logs](./model-logs.md)
- [Tool Definitions](./tool-definitions.md)
