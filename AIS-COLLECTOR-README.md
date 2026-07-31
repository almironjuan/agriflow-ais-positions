# AgriFlow AIS position archive

This repository stores verified AIS reports for vessels in the Argentina grain,
oilseed meal, by-product and vegetable-oil export line-up.

- The collector runs automatically twice per day.
- Every run listens for 20 minutes.
- Position reports and static identity messages are merged by MMSI.
- New identities are learned by conservative vessel-name matching and then
  persisted with MMSI, IMO, call sign and the AIS-declared destination.
- Once an MMSI is known, future positions are matched directly without relying
  on the vessel name again.
- Vessels remain tracked for 45 days after leaving the current line-up.
- Missing reports are kept as last-seen positions and are never estimated.

The AISStream API key is stored only as a GitHub Actions secret.
