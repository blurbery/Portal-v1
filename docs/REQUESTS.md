# Requests and Seerr

Portal keeps Seerr credentials server-side and exposes a member-facing Requests area through the Portal session. Members do not need Seerr passwords or direct Seerr access.

## Request flow

1. Configure Seerr and enable Requests in Administration.
2. Configure the member-provider permission toggles.
3. Configure Radarr/Sonarr instances and request categories. Category policies can cover movies, TV, anime, international, 4K, and other installation-specific areas.
4. Use the Requests sidebar to browse Discover, Movies, TV Shows, My Requests, and My Issues.
5. Requests are routed using the signed-in member provider and the matching Seerr/media-server configuration. If a provider-specific route is unavailable, the server uses the configured default route.

The browser receives normalized, non-secret request data. API keys remain in encrypted server-side settings and are never sent to members.

## Status and refresh behavior

After a request succeeds, the Portal updates the card immediately, keeps the user on the current Requests view, and refreshes request status from the server. My Requests and Discover status are also rebuilt after a page refresh, so a pending request does not depend on browser-only state.

Duplicate submissions are rejected when Seerr already reports an active request. The UI uses explicit states for requestable, pending/requested, available, and unavailable titles.

## Multiple providers and destinations

A Seerr connection is associated with a configured media-provider slot. Arr instances can be grouped by media provider, with up to twelve total Radarr/Sonarr instances per group. The provider association is inherited by the instances in that group; it is not repeated on every instance.

For each provider, the Portal applies the matching permission toggle before allowing Requests. This lets one installation route different providers to different Seerr and Arr destinations while preserving one member-facing Requests experience.

## Anime and international requests

Category policies are evaluated server-side for every request. Seerr-specific server/profile/root-folder overrides are applied only when configured. If an Arr-specific override causes Seerr to reject an otherwise valid request, Portal retries through Seerr’s default routing so valid anime, international, and other category requests can still be approved by the configured automation stack.

## Troubleshooting

- Confirm the Portal health endpoint is healthy and the configured Seerr URL is reachable from the Portal server.
- Check that the member’s provider account is linked and its provider permission is enabled.
- Check that the requested category is enabled and has a matching Arr instance or Seerr route.
- Inspect the Portal process logs for the request route and upstream Seerr response; do not expose API keys in issue reports.
