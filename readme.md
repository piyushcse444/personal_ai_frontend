# Person AI Frontend
npm.cmd run dev -- --host 0.0.0.0 --port 5173
Responsive React frontend for a personal AI product, built with Vite.

## Features

- Sign-up page at `/signup`
- Login page at `/login`
- Responsive split-panel layout that adapts for mobile
- Accessible labels, native form validation, and keyboard focus states
- Signup sends `email`, `displayName`, and `password` as JSON to `POST /api/auth/signup`
- Signup displays API errors and success feedback
- Login sends `email` and `password` as JSON to `POST /api/auth/login`
- Login accepts a JWT in a raw JWT response or a JSON `token`, `accessToken`, or `jwt` field (also nested under `data`)
- Login stores the token in `sessionStorage` as `personAi.accessToken`; it is not displayed on screen
- Successful login opens a personalized, game-inspired chat workspace using the `/users/me` profile with JWT claims as a fallback
- Authenticated chat, account, provider/model catalog, and provider configuration screens
- Server-backed conversation/message history, provider credentials management, profile editing, and account/session actions
- Offline models can start conversations without selecting a provider configuration
- Fixed-height chat workspace with an independently scrollable message history and responsive sidebar
- Message rows keep their natural size in long chats; mobile scrollbars remain subtly visible while scrolling
- Compact mobile composer/footer spacing with safe-area support
- Markdown-formatted assistant replies, including GitHub-style tables and copyable code blocks
- JWT-authenticated SSE chat responses with live tokens, collapsible thinking, usage counts, stop, and retry controls
- Per-device Thinking and Internet Access preferences sent to the backend with each streamed message request
- Provider and model catalog creation/deletion, including bulk model deletion
- Provider configuration creation omits the API key when all models for the selected provider are offline
- Filters an accidental leading `null` stream sentinel from displayed assistant responses
- Active conversations use `/chat/{conversationId}` routes, so reloading or sharing that URL restores the conversation and its message history

## API configuration

By default, the frontend uses the hostname from the browser URL and port `8080` for the backend. For example, opening the frontend at `http://192.168.1.25:5173` sends API requests to `http://192.168.1.25:8080/api`. The project-root `.env` leaves `VITE_API_BASE_URL` blank to enable this behavior:

```env
VITE_API_BASE_URL=
```

If the backend runs on a different host or port, set `VITE_API_BASE_URL` to its reachable base URL (without `/api`), for example `http://192.168.1.40:8080`. `src/config.js` reads this override; restart the Vite dev server after changing `.env`.

The frontend keeps the `/api` route prefix. For LAN access, the backend must listen on a network-reachable interface (not only `localhost`), and allow the frontend origin (for example `http://192.168.1.25:5173`) through CORS. For authenticated PATCH and streaming POST calls, allow the respective methods and the `Authorization` and `Content-Type` headers (as well as the browser's `OPTIONS` preflight). Stream requests accept `text/event-stream`. Requests use the access token as a bearer token. Refresh requests include cookies and send a refresh-token body when the login response provides one. Logout sends the refresh token when available, otherwise it relies on the refresh-session cookie.

If a request fails before an HTTP response is received, the UI shows its method and URL and suggests checking backend availability and CORS. Browser `Failed to fetch` errors alone cannot distinguish a CORS rejection from a network/server connection problem; inspect the `OPTIONS` preflight and its `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` response headers.

## Backend API coverage

The app calls these routes at `${VITE_API_BASE_URL}/api`:

- **Authentication:** `POST /auth/signup`, `POST /auth/login`, automatic `POST /auth/refresh` after an authenticated `401`, `POST /auth/logout`, and `POST /auth/logout-all`.
- **Account:** `GET` and `PATCH /users/me`; `DELETE /users/me` is available behind a confirmation flow.
- **Catalog:** provider/model list and detail reads; `POST`/`DELETE /providers`; `POST`/`DELETE /models`; and `DELETE /models` to remove all models.
- **Provider configurations:** `POST` and `GET /provider-configs` (including `?providerId=…` filtering); `GET`, `PATCH`, and `DELETE /provider-configs/{configId}`; `POST /provider-configs/{configId}/test`.
- **Conversations:** `POST` and paginated/searchable `GET /conversations`; `GET`, `PATCH`, and `DELETE /conversations/{conversationId}`.
- **Messages:** paginated `GET /conversations/{conversationId}/messages` and `POST /conversations/{conversationId}/messages/stream` with `{ "content": "...", "thinking": true|false, "internet": true|false }`. Thinking and Internet Access default to enabled and are persisted locally. The backend message DTO must accept `internet` (default true); when false, backend support is required to disable tools. The stream uses bearer-authenticated `fetch` and handles `token`, `done`, and `error` SSE events.

Provider configuration creation uses `POST /api/provider-configs` with `providerId`, `configName`, optional `endpointUrl`, and optional `apiKey`. The API key field is hidden when every model returned for the selected provider has `isOffline: true`; otherwise it is required. Configuration updates use `PATCH /api/provider-configs/{configId}` with `name`, optional `endpoint`, optional replacement `apiKey`, and `active`. Conversation create uses `modelId`, optional `providerConfigId`, and optional `title`; offline models do not require a provider configuration, so the frontend omits `providerConfigId` when none is selected. Keep these names aligned with the backend DTO.

The UI never displays or reuses stored provider credentials; it only displays the backend's `credentialConfigured` and `credentialMasked` fields. The display name comes from `/users/me`, falling back to JWT claims `displayName`, `name`, `preferred_username`, `username`, then `email`. The chat experience is driven by the selected backend model; no sample AI replies are generated by the frontend. Streamed message content appears as it arrives; thinking content is kept in a separate collapsible section.

## Getting started

Requires Node.js 20.19 or newer and npm.

From the project directory, install dependencies and start the development server:

**Windows PowerShell** (avoids the `npm.ps1` execution-policy error):

```sh
npm.cmd install
npm.cmd run dev
```

In Command Prompt, macOS, Linux, or another shell, use `npm install` and `npm run dev`.

Open the local URL printed by Vite (usually `http://localhost:5173`). Visit `/signup` or `/login` to view either page. Stop the server with `Ctrl+C`.

## Scripts

```sh
npm run dev      # Start the development server
npm run build    # Create a production build
npm run preview  # Preview the production build
npm run lint     # Run Oxlint
```

## Changes done

- Initialized a React 19 + Vite frontend project.
- Replaced the starter screen with responsive signup and login experiences.
- Added client-side form validation and navigation between auth pages.
- Connected signup to `POST /api/auth/signup`, with API error and success feedback.
- Connected login to `POST /api/auth/login`; the returned JWT is stored in tab-scoped `sessionStorage`.
- Redirected successful login into a personalized chat workspace and added automatic access-token refresh handling.
- Integrated account profile, provider/model discovery, provider configuration management, conversations, and message history/sending with the backend.
- Allowed conversations to use offline models without requiring or sending a provider configuration.
- Constrained the authenticated workspace to the dynamic viewport, with the message history as the chat's primary scroll area and the sidebar scrolling only when its history needs it.
- Refined message spacing, composer styling, responsive widths, and overflow handling for long responses.
- Prevented message rows from shrinking as the conversation grows; improved touch scrollbars and mobile safe-area/footer spacing.
- Rendered message Markdown and GitHub-flavored tables, with a copy control on code blocks.
- Added JWT-authenticated SSE streaming with incremental Markdown rendering, separated thinking content, token usage, request cancellation, and retry after failures or interrupted streams.
- Added a persisted Thinking toggle and included its boolean value in streamed message requests.
- Added a default-on, locally persisted Internet Access toggle beside Thinking and included its boolean value in every streamed message request.
- Added provider and model CRUD controls, including per-model and bulk deletion; offline-only providers can create configurations without an API key.
- Filtered the spurious leading `null` prefix from streamed assistant text, including when it arrives split across chunks.
- Automatic scrolling follows incoming stream chunks only while the reader remains near the bottom.
- Added provider-filtered configuration listing and paginated conversation/message history controls.
- Added confirmed account deletion and current-session/all-session logout actions.
- Kept profile name updates visible even when the backend returns an empty success response.
- Corrected provider configuration creation to use `POST /api/provider-configs` with `configName` and `endpoint`, matching the backend validation response; provider ID remains included for the required database relation.
- Improved API error parsing to show Spring-style validation error arrays.
- Improved fetch failure messages with the failed HTTP method/URL and CORS/network troubleshooting guidance.
- Recorded that the conversation rename failure was caused by backend CORS not allowing PATCH and is now resolved.
- Persisted the selected conversation in the URL and restore its details and message history on reload; browser back/forward and starting a blank chat update the selection.
- Updated chat streaming to move the active conversation to the top of the sidebar without a redundant per-send conversation-list request.
- Replaced the static API-online indicator with a neutral private-workspace status label.
- Made the default API host follow the hostname used to open the frontend, while retaining `VITE_API_BASE_URL` as an explicit override for remote backend hosts or nonstandard ports.
- Updated the document metadata and project documentation.
- Added Windows PowerShell-specific startup commands to avoid the `npm.ps1` execution-policy error.

## Documentation maintenance

For every future code or configuration update, update this README and `agent.md` in the same change with the completed work and any changed or upcoming plans. Keep the documented status accurate; do not list planned behavior as implemented.

## Upcoming plans

1. Verify frontend request and response DTOs against the running backend/OpenAPI schema.
2. Add focused automated tests for token refresh, SSE event parsing and cancellation, provider configuration CRUD, conversation pagination, and reload-safe conversation routing.
3. Add password reset and email verification if those backend operations are introduced.
4. Validate provider/model and optional-credential DTOs against the running backend/OpenAPI schema.
