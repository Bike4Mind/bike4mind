---
'@bike4mind/services': patch
---

Let notebook sharees with share access create invites. Accepting a notebook, file, or project invite minted by someone other than the owner now re-checks that person's current access: the invite is refused if they no longer hold share, and capped to what they still hold.
