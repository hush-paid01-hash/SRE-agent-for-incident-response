# SRE Agent for Incident Response

A lightweight, dependency-free Node.js web application that starts a session with your saved OpenAI SRE agent and streams its events and responses into a browser chat.

## What it does

- Reuses saved agent `agent_6b07841592908191861c7d992629d30e`.
- Applies the requested session overrides: model `gpt-6.2-astra`, the supplied SRE instructions, medium reasoning with automatic summary, and medium-verbosity text output.
- Leaves saved agent tools and other saved configuration untouched by not sending a tools override.
- Uses an OpenAI-hosted environment, so this starter does not require a separate executor installation.
- Streams the first turn from session creation and subscribes to session events before submitting follow-up messages.
- Keeps the OpenAI API key on the server; it is never sent to browser JavaScript.
- Displays live event types and surfaces API, lifecycle, and required-action errors.

## Requirements

- Node.js 20 or newer.
- An OpenAI project API key for project `proj_1tD6LR8kR1U5UHegdrNTP5LQ`.
- The key must have the Agents API permissions required by your project: `api.agents.read`, `api.agents.write`, and `api.responses.write`.

## Run locally

1. Clone this repository and enter its directory.
2. Create the environment file:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env` and set `OPENAI_API_KEY` to your project API key. Do not paste the key into chat, browser code, or commit it to Git.
4. Start the application:

   ```bash
   npm start
   ```

5. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

No npm packages are required.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Server-side OpenAI project API key |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` only behind a protected network/reverse proxy |
| `PORT` | `3000` | HTTP port |

## API behavior

- `POST /api/sessions` creates a session with the saved agent ID, session-level overrides, `environment.type = openai_hosted`, and `stream = true`.
- `POST /api/sessions/:session_id/messages` opens the event stream first, then sends an `agent.session.input.message` event with a unique `Idempotency-Key`.
- `GET /api/sessions/:session_id` retrieves session state, including status and any required actions.
- `GET /api/health` reports whether the server has an API key configured. It does not expose the key.

## Important operational notes

- The saved agent's configured GitHub MCP integration can be used only if its saved connection and credential are valid for the project. The optional AWS MCP server remains optional. This application does not assume those integrations are connected.
- This starter surfaces `requires_action` events and provides a session retrieval endpoint, but it does not automatically execute arbitrary function calls, connect external environments, or approve computer-use requests. Review required actions before proceeding.
- The agent instructions prohibit infrastructure changes, restarts, and rollbacks without explicit authorization. Keep that safety boundary.
- The app binds to localhost by default. Before exposing it on a public server, add authentication, HTTPS, rate limiting, and a protected reverse proxy. Do not expose an unauthenticated instance to the public internet.
- The browser stores only the current session ID in local storage. The API key remains server-side.

## Troubleshooting

- **API key missing:** copy `.env.example` to `.env`, set the key, and restart Node.
- **401/403:** verify the key belongs to project `proj_1tD6LR8kR1U5UHegdrNTP5LQ` and has the required Agents API permissions.
- **Agent not found / access denied:** confirm the saved agent is available to that same OpenAI project.
- **Tool or integration unavailable:** verify the saved agent's MCP connection and credential in the OpenAI project. A configured tool is not proof that its external account is connected.
- **Required action:** retrieve `GET /api/sessions/:session_id` and inspect `required_actions`; this starter intentionally does not auto-approve actions.

## API references

- [Agents API sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions)
- [Events and items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events)
- [Manage sessions and required actions](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage)
