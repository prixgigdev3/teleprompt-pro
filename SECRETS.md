# Secrets & API keys — how this project handles them

**TL;DR:** This repo is **public**. Real API keys/tokens are **never committed**.
They live only in `.env.local` on your machine (git-ignored). Right now the app
needs **no keys at all**.

## Where keys live

| File | Committed? | Contains | Purpose |
|------|-----------|----------|---------|
| `.env.local` | **No** (git-ignored) | your **real** keys | the single place you paste a key once; stays on your device |
| `.env.example` | Yes | placeholders only | documents which keys exist, for anyone setting up |
| `SECRETS.md` | Yes | this doc | the rules |

Paste real keys into **`.env.local`** and nowhere else. `.gitignore` blocks
`.env`, `.env.local`, `*.local.json`, and `secrets/` so they can't be pushed.

## Why not "just store them in the repo privately"

1. **This repo is public.** Any committed file is world-readable and is scraped by
   secret-harvesting bots within minutes of a push. A filename like "private"
   changes nothing. To store secrets *in GitHub*, use a **separate private repo**
   as a vault (see below).
2. **This is a client-side app.** Even in a private repo, any key placed in the
   shipped browser JavaScript is visible to anyone who opens the deployed app and
   looks at dev tools. A key in front-end code is not a secret.

## The correct pattern when we add a paid API

For a feature that needs a paid key (cloud speech-to-text, or the Claude API for
report analysis), do **one** of these — never hard-code the key in `js/`:

- **User-supplied key (simplest):** add a field in the app's settings; the user
  pastes *their own* key; it's stored in *their* browser `localStorage` and sent
  straight to the provider. The key never touches this repo or our servers.
- **Serverless proxy (most secure for a shared key):** a small function (Vercel/
  Cloudflare/Netlify) holds the key in its own environment secrets and proxies
  requests. The browser calls the proxy; the key never ships to the client.

## Backing secrets up to GitHub (private)

If you want your keys stored/synced via GitHub, create a **separate private repo**
(e.g. `teleprompt-pro-secrets`) and keep `.env.local` there. That repo is private
to your account; this public app repo stays key-free. Ask the setup agent to
"create the private secrets vault repo" and it will scaffold it.

## If a key is ever committed by accident

Treat it as compromised: **rotate it immediately** at the provider, then remove it
from git history (`git filter-repo` / BFG) and force-push. Rotation is the part
that actually protects you — deleting the file does not un-leak it.
