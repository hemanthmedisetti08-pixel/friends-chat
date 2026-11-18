# 💬 Friends Chat

FastAPI + WebSockets backend, plain HTML/CSS/JavaScript frontend.

## Run it (Windows / Mac / Linux)
```
cd friends-chat
python -m venv venv
venv\Scripts\activate          # Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
cd backend
uvicorn main:app --reload --host 0.0.0.0
```
Open http://localhost:8000 — register two accounts (use a normal window and a private window), add each other as friends, and chat.

**Phone on same Wi-Fi:** open `http://<your-PC-IP>:8000`. Voice recording and notifications need HTTPS on phones (they work on localhost on PC), so deploy behind HTTPS for real use.

## Use PostgreSQL instead of SQLite
Install it, `pip install psycopg2-binary`, then before starting:
`set DATABASE_URL=postgresql+psycopg2://user:password@localhost/chatdb` (Mac/Linux: `export ...`)

## Project layout
- `backend/main.py` – database models, REST API, WebSocket, file uploads
- `frontend/` – `index.html`, `style.css`, `app.js`

## Security built in / still to do before going public
- Built in: PBKDF2 password hashing, JWT login tokens (7 days), input validation, blocked file types, XSS-safe rendering, per-chat membership checks.
- Set a strong `SECRET_KEY` env var in production (otherwise one is generated into `backend/.secret`).
- Serve over HTTPS, add login rate-limiting, and restrict upload access if you need private media.
- Group read receipts: "read" turns blue when any member has read the message.

## Put it online as a website (free, Render.com)
1. Create a free account at github.com and upload this folder as a new repository (the `.gitignore` keeps secrets out).
2. Create a free account at render.com → **New → Blueprint** → pick your repository. `render.yaml` sets up the website and a PostgreSQL database for you.
3. Wait for the build. You get a public `https://friends-chat-xxxx.onrender.com` link that works on Android and PC, with HTTPS (so voice messages and notifications work).

Notes: the free plan sleeps after inactivity (first load is slow), and uploaded photos/videos are wiped on each redeploy. For permanent media storage, add a Render Disk (paid) or cloud storage later.

---
# 📞🎥 Voice & Video Calling (added)

One-to-one audio and video calls between friends using **WebRTC**.
Audio/video goes **directly between the two browsers**; our FastAPI server only passes small "signaling" messages
(call request, accept, reject, end, WebRTC offer/answer/ICE) over the existing chat WebSocket. Nothing is recorded or stored.

## What changed in your project
| File | Change |
|---|---|
| `backend/main.py` | New `CallLog` table, `/api/ice`, `/api/calls`, call signaling (`call_*` WebSocket events), friend/auth checks, cleanup when someone disconnects |
| `frontend/calls.js` | **New.** All calling logic (WebRTC, call screen, mute, camera, timer) |
| `frontend/index.html` | 📞 🎥 buttons in the chat header, incoming-call popup, call screen, `calls.js` script tag |
| `frontend/app.js` | 5 tiny hooks (route `call_*` events, hide buttons in groups, recent calls in Settings) |
| `frontend/style.css` | Call styles appended at the end |
| `render.yaml` | TURN environment variables |

No existing table is changed. The new `call_logs` table is created automatically on the next start (existing data is untouched).

## Environment variables (Render → your service → Environment)
| Variable | Required? | Meaning |
|---|---|---|
| `TURN_URLS` | Recommended | Comma-separated TURN addresses from your TURN provider, e.g. `turn:HOST:80,turn:HOST:443?transport=tcp,turns:HOST:443?transport=tcp` |
| `TURN_USERNAME` | With TURN_URLS | Username given by the TURN provider |
| `TURN_CREDENTIAL` | With TURN_URLS | Password/credential given by the TURN provider |
| `TURN_SECRET` | Optional | Only if you run your own coturn with `use-auth-secret`; then `TURN_USERNAME/CREDENTIAL` are not needed |
| `STUN_URLS` | Optional | Defaults to Google's free STUN servers |

Credentials are handed to logged-in users by `/api/ice`; they are **not** written in any JavaScript file.

## TURN server (needed for some networks)
STUN lets most people connect directly. Behind strict networks (some mobile data, offices, symmetric NAT) a direct path is impossible and a **TURN relay** is required, otherwise the call stays on "Connecting…" and fails.
Render does not provide TURN, so use an external service, for example **Metered.ca** (has a free tier, check current limits), Twilio Network Traversal, or your own **coturn** server on a VPS.
With Metered: create an account → create a TURN app → copy the server URLs, username and credential into the three variables above.

## Deploy on Render (step by step)
1. Replace the changed files in your GitHub repository (see table) and add `frontend/calls.js`.
2. Commit and push. Render redeploys automatically.
3. In Render open your web service → **Environment** → add `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` → **Save** (it redeploys).
4. Always open the site through `https://...onrender.com` (calls need HTTPS; the chat automatically uses `wss://`). Render supports WebSockets, so no extra setting is needed.

## Test with two accounts
1. Open the site in a normal window (Account A) and a private window, or another phone (Account B). Make them friends.
2. A opens the chat with B and presses 📞. B should see an incoming-call popup with A's name/photo; press **Accept**. Allow the microphone. Both see "Connected" and a timer.
3. Test **mute**, then **End Call** on either side. Check Settings → Recent calls.
4. Repeat with 🎥: allow camera, check both videos, camera off/on and 🔄 (phone only).
5. Test **Reject**, let it ring for 45 s (missed), and calling while the friend is offline.
6. Real-world test: put one device on mobile data and the other on Wi-Fi. If it never connects, check your TURN variables.

Limits: one call per user at a time; group calls are not supported; on Render's free plan the first load after sleep is slow.
