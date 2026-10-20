---
"@bike4mind/common": major
---

Bind voice credit holds to their payer in the session repository contract.

Repository implementations must accept `payerId` in `openVoiceHold` and return
`payerId: string | null` from successful `claimVoiceHold` calls. Use `null` when a
legacy hold has no recorded payer. Pass the user funding the reserve when opening
a hold.

The unused `restoreVoiceHold` repository method and `VoiceHoldMarkers` export have
been removed. Consumers must remove those references; settlement rollback belongs
inside the transaction that claims the hold and moves credits.
