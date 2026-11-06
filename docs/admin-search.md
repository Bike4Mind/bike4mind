# Admin identifier search

Open Commands with Cmd/Ctrl+K anywhere in the admin console. Enter an exact email,
user, organization or key ID, billing customer ID, displayed API key prefix, IP
address, or exact organization name. Email and organization names ignore case.
Arrow keys select a result, Enter opens it, and Escape closes the palette.
Results label users, API keys and organizations separately; ambiguous identifiers
can return more than one type. Each type returns at most five results.

The search is available to full platform admins with a first-party session. It
returns masked emails, displayed key prefixes and abbreviated organization IDs.
Never paste a full API key. Key results open their owner's API keys tab; organization
results open the organization profile.

IP searches inspect the latest 100 matching sign-in records and up to 100 distinct
API users, then resolve the five most recently active owners. They reflect retained
records, not all historical activity. Searches by IP or key prefix write an audit entry
containing the identifier type rather than the query. Each admin can make 30 searches per minute.

## Troubleshooting

- No matches: check the identifier; names require the complete organization name.
- Search failed: edit the query to retry. If it persists, check the index migration
  `ensure admin search indexes` completed. Queries require named indexes and fail
  rather than falling back to a collection scan.
- Rate limit: wait one minute before searching again.
- Delegated admin: identifier search requires a full platform admin; page commands
  remain available according to the existing tab permissions.

Database latency depends on the deployed data and indexes. The 500 ms target needs
measurement on the deployment; local unit tests do not establish that latency.
