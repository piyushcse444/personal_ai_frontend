# Agent Guide

## Project

Person AI is a React 19 frontend built with Vite. Authenticated workspace surfaces include chat, provider/model catalog, personal provider configurations, and account settings.

## Current state

- `/signup` and `/login` render auth screens; successful login opens the authenticated workspace.
- Auth routes use `/api/auth/...`; `src/api.js` adds the agreed `/api` prefix to paths.
- `src/api.js` centralizes authenticated JSON requests, handles a 401 with one refresh attempt, and clears/emits session expiry if refresh fails.
- Access and optional refresh tokens are tab-scoped in `sessionStorage`; never render tokens or provider secrets.
- The workspace fetches `/users/me`, providers, models, personal provider configs, conversations, and message history from the backend.
- Chat sends actual requests to the selected model via `POST /conversations/{conversationId}/messages`; no frontend-generated assistant replies are used.
- Message POST responses contain `userMessage` and `assistantMessage`; append those returned records directly and avoid redundant message-history and conversation-list GET requests after sending. Existing GET history remains for opening/restoring conversations.
- The selected conversation is represented by `/chat/{conversationId}`. Opening/creating a conversation updates browser history, reload restores its details and messages, and back/forward navigation switches conversations.
- Display name resolves from `/users/me`, with JWT claims (`displayName`, `name`, `preferred_username`, `username`, `email`) as fallback.
- Account delete is included with explicit confirmation; logout and logout-all call their backend endpoints.
- The API base URL is configured with `VITE_API_BASE_URL` in the project-root `.env` file and read by `src/config.js`; the current value is `http://localhost:8080`.
- Both auth forms display API errors/success and use browser-native validation.
- The UI is responsive and includes labels, keyboard focus styles, and reduced-motion support.

## API integration

The base URL is `VITE_API_BASE_URL` in the root `.env`; paths passed to `apiGet`, `apiPost`, `apiPatch`, or `apiDelete` omit `/api`, since `src/api.js` adds it. Keep payload property names aligned with the backend DTO. Signup uses `email`, `displayName`, and `password`; login uses `email` and `password`.

Implemented routes: authentication signup/login/refresh/logout/logout-all; `GET/PATCH/DELETE /users/me`; provider and model catalog list/detail/provider-model/filter reads; provider-config create/list/filter-by-provider/detail/update/delete/test; conversation create/list/search/pagination/detail/update/delete; message history pagination and send.

Provider config create/list/detail/update/delete/test use the plural `/provider-configs` routes. Creation uses `POST /api/provider-configs` with `providerId`, `configName`, `endpoint`, and `apiKey` (camelCase, as required by the backend request DTO). Updates use `name`, optional `endpoint`, optional replacement `apiKey`, and `active`, unless the backend update DTO specifies otherwise. Config responses must never expose the actual secret; only display masked/configured status. Conversation create uses `modelId`, `providerConfigId`, optional `title`; selection updates submit both IDs. The API descriptions did not include complete response DTOs, so `src/api.js` supports common `data`, `items`, `content`, `results`, and named collection envelopes. Validate fields and envelopes against the backend's OpenAPI contract.

Browser requests need backend CORS configured for the local Vite origin. For authenticated PATCH requests, allow PATCH, Authorization, Content-Type, and OPTIONS preflight. The conversation rename issue was confirmed resolved by allowing PATCH in backend CORS. Authenticated requests send bearer access tokens. Refresh uses a returned refresh-token body when available and includes cookies for cookie-based refresh sessions. Logout sends the refresh token if returned at login, otherwise it relies on the refresh-session cookie. Fetch failures should report method/URL and CORS/network guidance because browser errors cannot reliably distinguish CORS blocking from a network failure.

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
- Added provider-filtered provider-config listing and paginated message history controls.
- Replaced demo chat replies with backend conversation/message calls.
- Added profile update, current/all session logout, and confirmed account deletion.
- Preserved updated profile display names for empty-success PATCH responses.
- Kept workspace status copy neutral so it does not claim the API is connected before requests succeed.
- Corrected provider config creation to use `configName` based on backend validation feedback and display Spring validation error arrays.
- Added method/URL-specific fetch failure details and CORS troubleshooting guidance.
- Recorded the backend CORS PATCH fix that resolved conversation renaming.
- Added reload-safe active conversation URLs and browser history restoration; blank-chat navigation and deleting the active conversation clear the selected route.
- Consumed the backend message-send response (`userMessage` and `assistantMessage`) directly and removed the per-send GETs for history and conversations; locally move the active conversation to the sidebar top.
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
2. Add focused automated tests for session refresh, config CRUD, conversation pagination, POST message-response handling, and reload-safe conversation routing.
3. Implement password reset/email verification if supported by the backend.
4. Consider streaming responses and persistent UI preferences after validating standard API behavior.
