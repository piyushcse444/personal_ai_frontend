# Agent Guide

## Project

Person AI is a React 19 frontend built with Vite. Authenticated workspace surfaces include chat, provider/model catalog, personal provider configurations, and account settings.

## Current state

- `/signup` and `/login` render auth screens; successful login opens the authenticated workspace.
- Auth routes use `/api/auth/...`; `src/api.js` adds the agreed `/api` prefix to paths.
- `src/api.js` centralizes authenticated JSON requests, handles a 401 with one refresh attempt, and clears/emits session expiry if refresh fails.
- Access and optional refresh tokens are tab-scoped in `sessionStorage`; never render tokens or provider secrets.
- The workspace fetches `/users/me`, providers, models, personal provider configs, conversations, and message history from the backend.
- Chat sends actual requests to the selected model via JWT-authenticated `POST /conversations/{conversationId}/messages/stream`, consuming `token`, `done`, and `error` SSE events with fetch and a readable stream; no frontend-generated assistant replies are used.
- Offline models (`isOffline: true`) can start conversations without a provider configuration; `providerConfigId` is omitted when none is selected.
- The authenticated workspace is constrained to `100dvh`; the chat message list is its primary scroll area, and the sidebar scrolls independently when conversation history exceeds available space.
- Chat message rows retain their natural height instead of flex-shrinking in long conversations. Touch devices get a subtle visible scrollbar, and the mobile composer/footer accounts for the safe-area inset.
- Message content is rendered as Markdown with GitHub-flavored tables and copyable fenced code blocks. Auto-scroll remains enabled only while the reader is near the bottom.
- Streaming supports a collapsible thinking section, usage counts, AbortController cancellation, and retry after errors or interrupted connections.
- Locally persisted Thinking and Internet Access toggles are sent as `thinking` and `internet` on every streamed request; both default to enabled.
- The provider/model catalog supports provider and model creation, provider and individual/bulk model deletion.
- Provider config creation omits `apiKey` for a provider whose complete model list reports `isOffline: true`; other providers require a key.
- The stream renderer ignores an accidental leading literal `null` sentinel, even when it arrives split across token events.
- Existing paginated message-history GET requests remain for opening and restoring conversations.
- The selected conversation is represented by `/chat/{conversationId}`. Opening/creating a conversation updates browser history, reload restores its details and messages, and back/forward navigation switches conversations.
- Display name resolves from `/users/me`, with JWT claims (`displayName`, `name`, `preferred_username`, `username`, `email`) as fallback.
- Account delete is included with explicit confirmation; logout and logout-all call their backend endpoints.
- `src/config.js` defaults the API host to the current browser hostname on port `8080`; a non-empty `VITE_API_BASE_URL` in the project `.env` overrides it.
- Both auth forms display API errors/success and use browser-native validation.
- The UI is responsive and includes labels, keyboard focus styles, and reduced-motion support.

## API integration

The default API base is `${window.location.protocol}//${window.location.hostname}:8080`; a non-empty `VITE_API_BASE_URL` in the root `.env` overrides it. API paths passed to `apiGet`, `apiPost`, `apiPatch`, `apiDelete`, or `apiStream` omit `/api`, since `src/api.js` adds it. Keep payload property names aligned with the backend DTO. Signup uses `email`, `displayName`, and `password`; login uses `email` and `password`.

Implemented routes: authentication signup/login/refresh/logout/logout-all; `GET/PATCH/DELETE /users/me`; provider and model catalog list/detail/provider-model/filter reads plus provider/model create/delete and bulk model delete; provider-config create/list/filter-by-provider/detail/update/delete/test; conversation create/list/search/pagination/detail/update/delete; message history pagination and SSE message streaming.

Provider config create/list/detail/update/delete/test use the plural `/provider-configs` routes. Creation uses `POST /api/provider-configs` with `providerId`, `configName`, optional `endpointUrl`, and optional `apiKey`; the key is optional only when all models returned for the selected provider have `isOffline: true`. Updates use `name`, optional `endpoint`, optional replacement `apiKey`, and `active`, unless the backend update DTO specifies otherwise. Config responses must never expose the actual secret; only display masked/configured status. Conversation create uses `modelId`, optional `providerConfigId`, and optional `title`; `providerConfigId` is omitted when an offline model does not need a configuration. The streamed message body contains `content` and the persisted `thinking` and `internet` booleans. The backend message DTO must accept `internet` (default true) and disable tools when false. Selection updates include the config ID only when one is selected. The API descriptions did not include complete response DTOs, so `src/api.js` supports common `data`, `items`, `content`, `results`, and named collection envelopes. Validate fields and envelopes against the backend's OpenAPI contract.

Browser requests need backend CORS configured for the actual Vite origin. For LAN access the backend must listen on a network-reachable interface, not only `localhost`. For authenticated PATCH and streaming POST requests, allow the respective method, Authorization and Content-Type headers, and OPTIONS preflight. Streaming requests accept `text/event-stream`. The conversation rename issue was confirmed resolved by allowing PATCH in backend CORS. Authenticated requests send bearer access tokens. Refresh uses a returned refresh-token body when available and includes cookies for cookie-based refresh sessions. Logout sends the refresh token if returned at login, otherwise it relies on the refresh-session cookie. Fetch failures should report method/URL and CORS/network guidance because browser errors cannot reliably distinguish CORS blocking from a network failure.

## Starting the project

Requires Node.js 20.19 or newer and npm. From the project root, run:

In Windows PowerShell, use `npm.cmd` to avoid PowerShell blocking the `npm.ps1` script:

```sh
npm.cmd install
npm.cmd run dev
```

In Command Prompt, macOS, Linux, or another shell, use `npm install` followed by `npm run dev`.

Open the local URL printed by Vite, usually `http://localhost:5173`. Use `/signup` or `/login` for the auth pages. Stop the development server with `Ctrl+C`.

## Changes done

- Created the Vite + React project scaffold and project scripts.
- Built responsive signup and login screens with shared branding and navigation.
- Added a shared API client with bearer auth, response/error parsing, automatic refresh retry, and session-expiry handling.
- Connected account/profile, provider/model catalog, personal provider config CRUD/test, conversation CRUD/search/pagination, and message history/send flows.
- Allowed conversations to use offline models without requiring a provider configuration.
- Constrained the chat layout to the viewport, removed nested chat scrolling, and polished the composer, message typography, responsive behavior, and long-content overflow.
- Prevented flex-shrinking of message rows in long chats, improved mobile scrollbar visibility, and tightened the safe-area-aware composer footer spacing.
- Added Markdown and GFM rendering for message content with a fenced-code copy button; added bearer-authenticated SSE message streaming with cancellation and retry.
- Added the persisted Thinking toggle and included its boolean value in streamed message payloads.
- Added a default-on, locally persisted Internet Access toggle beside Thinking and included its boolean value in streamed message payloads; the backend DTO/controller support remains an external integration requirement for this frontend repository.
- Added provider/model CRUD UI, including individual and bulk model deletion, and API-key omission for offline-only providers.
- Filtered the leading `null` stream sentinel from assistant responses, including split-token delivery.
- Added provider-filtered provider-config listing and paginated message history controls.
- Replaced demo chat replies with backend conversation/message calls.
- Added profile update, current/all session logout, and confirmed account deletion.
- Preserved updated profile display names for empty-success PATCH responses.
- Kept workspace status copy neutral so it does not claim the API is connected before requests succeed.
- Corrected provider config creation to use `configName` based on backend validation feedback and display Spring validation error arrays.
- Added method/URL-specific fetch failure details and CORS troubleshooting guidance.
- Recorded the backend CORS PATCH fix that resolved conversation renaming.
- Added reload-safe active conversation URLs and browser history restoration; blank-chat navigation and deleting the active conversation clear the selected route.
- Streamed assistant content directly from the backend and locally moved the active conversation to the sidebar top without per-send history GET requests.
- Made the default API host follow the browser hostname so LAN clients call the backend on that same host; retained the environment override for backends on another host or port.
- Updated docs with endpoint coverage and the assumed DTO property names.
- Added `.env` API base URL configuration, centralized in `src/config.js`.
- Clarified in `readme.md` exactly where to edit the backend base URL and to restart Vite afterward.
- Updated `readme.md` with project setup, scripts, completed changes, and roadmap.
- Documented how to install dependencies and start the development server in both project docs.
- Added PowerShell-specific `npm.cmd` commands to work around script execution policy restrictions without changing the machine's policy.

## Working guidance

1. With every code or configuration update, update both `readme.md` and `agent.md` in the same change to record what changed and revise upcoming plans as needed.
2. Keep documentation aligned with implemented behavior; clearly label features that are still UI-only.
3. Keep changes focused and follow the existing React and CSS conventions.
4. Use semantic HTML, accessible labels, keyboard support, and responsive layouts.
5. Run `npm run lint` and `npm run build` after relevant changes.
6. Do not add credentials or commit secrets. The API base URL is not secret; keep it in `.env`, not hard-coded into components.

## Upcoming plans

1. Verify payload and response DTOs against the backend OpenAPI schema and adjust adapters.
2. Add focused automated tests for session refresh, SSE event parsing and cancellation, config CRUD, conversation pagination, and reload-safe conversation routing.
3. Implement password reset/email verification if supported by the backend.
4. Validate provider/model and optional-credential DTOs against the backend OpenAPI schema.
