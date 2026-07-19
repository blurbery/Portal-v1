[BUILD_REPORT.md](https://github.com/user-attachments/files/30162729/BUILD_REPORT.md)
# Build v1 report

## Completed

- Created a separate repository directory; the private portal source was not modified.
- Removed owner-specific domain defaults, role defaults, and visible credentials from the clone.
- Added `.env.example`, `.gitignore`, package metadata, Supabase/hosting-provider setup instructions, security rules, and update-boundary guidance.
- Added neutral provider configuration for Emby, Silo, Jellyfin, Plex, Discord OAuth, and optional Seerr.
- `node --check server.js` passes.

## Privacy and provider-neutrality review

The legacy provider-specific UI, server paths, provider fields, account tables, and related session/admin wiring have been removed from the GitHub build. The private production portal was not modified.

The same review should decide whether the Library/BookWarehouse/Shelfmark features remain in v1 as neutral optional integrations or are moved into a separate repository. Their private defaults were removed, but the feature code is still part of the copied portal.

This report records the separation boundary: installation-specific credentials and provider settings must be supplied by each operator through environment variables or encrypted portal settings.
