---
"@bike4mind/common": major
"@bike4mind/services": major
---

Remove the retired `ReferralCreditsAmount` setting from `SettingKeySchema`, `SettingKey`, and `settingsMap`, and remove `userService.referralInviteCredits` from the services API. Referral signups now use `newSignupGrant` with the standard signup schedule; consumers must stop reading the retired setting or calling the removed helper.
