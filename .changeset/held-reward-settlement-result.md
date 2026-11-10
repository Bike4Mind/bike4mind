---
"@bike4mind/services": major
---

HeldCreditRewardRepository.settle now returns Promise<number> with the number of rows settled,
and accepts an optional { credits } condition. Adapter implementations must apply that condition
atomically and return 0 when it does not match, so concurrent reward adjustments can roll back
their payout transaction.
