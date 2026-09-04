---
"@bike4mind/cli": patch
---

`b4m plugin remove` now passes `--no-fund --no-audit` to `npm uninstall`, matching what
`plugin add` already passed to `npm install`. Without them npm fetches funding and audit
metadata during an uninstall, which never returns where egress is filtered by dropping
packets rather than refusing the connection - so `plugin remove` hung until its 120s npm
timeout and then exited 1. A connection-refused registry does not show this, since a fast
RST lets npm give up and proceed.
