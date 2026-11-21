# Update notice layout evidence

Actual desktop renderer with synthetic Code-session, project, conversation and update data.
Captured in Chromium using the branch source. No account data or update service was used.
The sidebar is expanded at its default width.

- Default window: 1280 x 800, session panel closed and open.
- Narrow window: 800 x 700, session panel closed and open.
- The panel uses its responsive modal layout at these widths; the update notice is
  intentionally hidden while that modal is open.
- Input and Send button bounding boxes are checked against the notice, and the
  Send button's center is checked with browser hit testing.

The draft in each screenshot is unsent synthetic text.
