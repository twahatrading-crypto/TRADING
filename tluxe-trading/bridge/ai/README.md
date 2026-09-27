# Trading by TLUXE — TLUXE AI backend (READ-ONLY assistant)

```
TLUXE AI panel (browser) → THIS backend (127.0.0.1:8767, bridge token) → OpenAI Responses API (official `openai` SDK)
```

The browser never calls OpenAI and never sees the OpenAI key. Phase 1 = **Chat only, read-only**: the model gets the
conversation plus a bounded, provenance-tagged market / engine context and **no tools** — it cannot place or modify
orders, control MT5, run commands, read / write files, change engine settings or read the environment.

## Setup (Windows)

```bat
cd C:\Users\twaha\TRADING\tluxe-trading\bridge\ai
copy .env.example .env
```

Edit `bridge\ai\.env` (gitignored — never commit it):

- `OPENAI_API_KEY=` your OpenAI key (server-side only; never in the browser, chat, source files or Git).
- `TLUXE_AI_TOKEN=` a new random secret: `py -c "import secrets; print(secrets.token_urlsafe(32))"`.
- Optional: `TLUXE_AI_MODEL` (default `gpt-5.5`), `TLUXE_AI_TIMEOUT_S`, `TLUXE_AI_MAX_OUTPUT_TOKENS`.

Start: `bridge\ai\start_ai.cmd` (first run creates `.venv` and installs `requirements.txt`).
Then in TLUXE (http://localhost:5182) → **Settings → TLUXE AI**: enable, URL `http://127.0.0.1:8767`, paste the
**backend token** (NOT the OpenAI key) → Save.

## Status

`GET /api/ai/health` (needs the token) → `status`: `CONNECTED` only after OpenAI itself confirmed the key and the
model (`models.retrieve`, no tokens spent; cached 5 min). Otherwise `NOT_CONFIGURED` (no key), `AUTH_ERROR`,
`MODEL_UNAVAILABLE`, `RATE_LIMITED`, `UNREACHABLE`. The UI shows **Connected** only for `CONNECTED`.
Quick check from a terminal (replace the token placeholder, never paste it anywhere public):

```bat
curl -H "Authorization: Bearer <TLUXE_AI_TOKEN>" http://127.0.0.1:8767/api/ai/health
```

## API

| method | path | body | notes |
|---|---|---|---|
| GET | `/api/ai/health` | — | safe status, model, read-only permissions, limits (never the key) |
| POST | `/api/ai/chat` | `{mode:"chat", messages:[{role,content}], context?}` | ≤ 40 messages, ≤ 8 000 chars each, ≤ 64 000 total, context ≤ 24 KB, body ≤ 256 KB |

Bearer token on every request; exact browser-origin allowlist (`TLUXE_AI_ALLOWED_ORIGINS`, default 5182 / 5181 /
4181 on localhost + 127.0.0.1; `*` is refused); binds to 127.0.0.1 only; 2 concurrent chats max; errors are
readable codes (`PROVIDER_AUTH`, `RATE_LIMITED`, `TIMEOUT`, …) and never contain secrets; an empty model answer is an
error (`EMPTY_RESPONSE`), never a placeholder. Logs are redacted (key, token, anything `sk-…`).

Ports: MT5 bridge 8765 · Databento bridge 8766 · **TLUXE AI 8767** · Vite preview 5182.

## Tests

`.venv\Scripts\python -m unittest discover -s tests` (TEST DATA: a scripted stand-in for the OpenAI client; no network).
