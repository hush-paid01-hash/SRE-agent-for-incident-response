import http from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;
const API_BASE = "https://api.openai.com/v1";
const AGENT_ID = "agent_6b07841592908191861c7d992629d30e";

const AGENT_OVERRIDES = {
  model: "gpt-6.2-astra",
  instructions: `You are an SRE assistant investigating production incidents. Help the user understand the impact, identify the likely cause, and choose a safe next step.
1. Establish the affected service, symptoms, incident time window, and customer impact. Ask for missing details that materially affect the investigation.
2. Inspect the evidence provided by the user and relevant logs, runbooks, repositories, and incident history available in your workspace. Use configured scripts or command-line tools for additional read-only investigation when available. Do not assume access to Slack, GitHub, AWS, or monitoring systems; explain which missing access or evidence is needed.
3. Build a timeline, compare recent deployments or configuration changes, and test competing explanations. Distinguish observations from hypotheses and cite the files, log entries, or query results supporting each conclusion.
4. Summarize impact, the most likely cause, confidence, and remaining questions. Recommend a mitigation with its risks, verification steps, and rollback plan.
Do not change infrastructure, restart services, or perform a rollback without explicit authorization. Never invent telemetry or claim an action succeeded without evidence.`,
  reasoning: { effort: "medium", summary: "auto" },
  text: { format: { type: "text" }, verbosity: "medium" }
};

const INITIAL_MESSAGE = "Start an incident-response session. Please introduce yourself briefly, then ask me for the affected service, symptoms, incident time window, and customer impact. Do not assume an incident is active.";

function loadEnv(file) {
  try {
    const source = requireText(file);
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "");
      }
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function requireText(file) {
  return readFileSync(file);
}

import { readFileSync } from "node:fs";

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function apiHeaders(extra = {}) {
  return {
    authorization: `Bearer ${API_KEY}`,
    "OpenAI-Beta": "agents=v1",
    ...extra
  };
}

async function openaiError(response) {
  const raw = await response.text();
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    message = parsed.error?.message || parsed.message || raw;
  } catch {}
  return { error: message || `OpenAI API returned HTTP ${response.status}`, status: response.status };
}

async function proxyStream(upstream, res) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      apiKeyConfigured: Boolean(API_KEY),
      agentId: AGENT_ID,
      runtime: "node",
      environment: "openai_hosted"
    });
  }

  if (url.pathname.startsWith("/api/")) {
    if (!API_KEY) return json(res, 503, { error: "OPENAI_API_KEY is not configured. Copy .env.example to .env and add your project API key." });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req);
    const input = typeof body.input === "string" && body.input.trim() ? body.input.trim() : INITIAL_MESSAGE;
    const upstream = await fetch(`${API_BASE}/agents/sessions`, {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({
        agent_id: AGENT_ID,
        agent: AGENT_OVERRIDES,
        environment: { type: "openai_hosted" },
        input,
        stream: true
      })
    });
    if (!upstream.ok) return json(res, upstream.status, await openaiError(upstream));
    return proxyStream(upstream, res);
  }

  const messageMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const sessionId = messageMatch[1];
    const body = await readJson(req);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return json(res, 400, { error: "Message cannot be empty." });

    // Open the event stream before submitting the message so early turn events are not missed.
    const streamUrl = `${API_BASE}/agents/sessions/${encodeURIComponent(sessionId)}/events?stream=true`;
    const streamResponse = await fetch(streamUrl, {
      method: "GET",
      headers: apiHeaders({ accept: "text/event-stream" })
    });
    if (!streamResponse.ok) return json(res, streamResponse.status, await openaiError(streamResponse));

    const submissionKey = crypto.randomUUID();
    const submission = await fetch(`${API_BASE}/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      headers: apiHeaders({
        "content-type": "application/json",
        "Idempotency-Key": submissionKey
      }),
      body: JSON.stringify({
        events: [{
          type: "agent.session.input.message",
          input: [{
            role: "user",
            content: [{ type: "input_text", text: message }]
          }]
        }]
      })
    });

    if (!submission.ok) {
      await streamResponse.body?.cancel();
      return json(res, submission.status, await openaiError(submission));
    }
    return proxyStream(streamResponse, res);
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && sessionMatch) {
    const upstream = await fetch(`${API_BASE}/agents/sessions/${encodeURIComponent(sessionMatch[1])}`, {
      headers: apiHeaders({ accept: "application/json" })
    });
    if (!upstream.ok) return json(res, upstream.status, await openaiError(upstream));
    res.writeHead(upstream.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    return res.end(await upstream.text());
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      "x-content-type-options": "nosniff"
    });
    return createReadStream(path.join(ROOT, "public", "index.html")).pipe(res);
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  return json(res, 404, { error: "Not found." });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error("[server]", error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || "Unexpected server error." });
    else res.destroy(error);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SRE Agent app listening at http://${HOST}:${PORT}`);
  console.log(`Saved agent: ${AGENT_ID}`);
  console.log(`OpenAI API key: ${API_KEY ? "configured" : "missing (set OPENAI_API_KEY)"}`);
});
