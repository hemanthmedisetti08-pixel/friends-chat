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

---
# ⚙️ Settings (added in v1.3.0)

A full Settings page (⚙️ in the sidebar, or tap your name). Ten sections: Account, Privacy, Security, Chats, Notifications, Storage and data, Profile, Linked devices, Accessibility, Help and support, plus search. Every control reads and writes real data on the server.

## Folder structure
```
friends-chat/
├── backend/
│   ├── main.py            ← replace (sessions, privacy rules, 2FA login, typing, read receipts)
│   └── settings_api.py    ← NEW (all settings / account / security / storage endpoints)
├── frontend/
│   ├── index.html         ← replace
│   ├── app.js             ← replace (small hooks)
│   ├── calls.js           ← replace (call alerts follow notification settings)
│   ├── settings.js        ← NEW (Settings page)
│   ├── settings.css       ← NEW (Settings styles)
│   └── style.css          ← unchanged
├── render.yaml            ← replace
└── README.md
```

## Database changes / migration
Nothing to run by hand. On start, `create_all` adds **3 new tables** and does not touch existing ones, so PostgreSQL on Render keeps all data:
| Table | Purpose |
|---|---|
| `user_settings` | one row per user: all preferences as JSON (incl. per-chat archive/mute/clear) + two-step secret |
| `login_sessions` | one row per logged-in device (real session list, revocable) |
| `support_reports` | messages from "Contact support" / "Report a problem" |

**One-time effect:** old login tokens have no session id, so everyone is asked to log in once after this update.
Read support messages in the Render database shell: `SELECT * FROM support_reports ORDER BY id DESC;`

## What each setting really does
- **Privacy** (last seen, online, photo, about; Everyone / My contacts / My contacts except… / Nobody): enforced on the server in every response that contains another user's profile (chats, friends, search, presence, calls). **Read receipts off**: your reads never turn the sender's ticks blue. **Typing indicators**: the server only relays "typing…" if both people allow it.
- **Security**: real TOTP two-step verification (Google/Microsoft Authenticator, Authy), required at login. Every login creates a session; logging a device out revokes its token and closes its WebSocket at once. Security alerts arrive live on your other devices.
- **Chats**: theme, wallpaper, font size, Enter-sends, list preview, media auto-download, archive, per-user clear/delete, JSON backup download.
- **Notifications**: message/group/call switches, sound choice, preview, desktop notifications + browser permission, vibration (if supported), per-chat mute (8 h / 1 week / always).
- **Storage and data**: real file sizes from the server disk (photos/videos/audio/documents), delete your own media, bulk cleanup. Websites cannot measure network usage; the page shows what the browser reports.
- **Account**: change email/phone/password (password required), download account data, delete account (password + typing DELETE (+ 2FA code)). Deleting removes the user, messages, uploaded files, friendships, call history, sessions and settings; 1-to-1 chats disappear for the friend too.
- **Accessibility**: UI font size 80–150%, high contrast, reduce animations, keyboard focus outlines, ARIA labels.

## API endpoints (all need `Authorization: Bearer <token>` except login/register/app-info)
| Method & path | What it does |
|---|---|
| `GET /api/settings` | all settings (defaults + saved) |
| `PATCH /api/settings` `{"values":{"privacy.last_seen":"nobody"}}` | validated update of one or more settings |
| `POST /api/settings/reset-privacy` | back to default privacy |
| `GET /api/profile/preview` | how contacts / everyone see your profile |
| `PUT /api/chats/{id}/prefs` `{archived, muted_until}` | archive / mute a chat |
| `POST /api/chats/{id}/clear` · `/delete` | clear / delete a chat for you only |
| `GET /api/chats/export?chat_id=` | JSON chat backup |
| `GET /api/account` | account info |
| `PUT /api/account/email` · `/phone` · `POST /api/account/password` | change (current password required) |
| `GET /api/account/export` | download account information |
| `POST /api/account/delete` `{password, confirm:"DELETE", code}` | permanent deletion |
| `GET /api/security/2fa` · `POST /2fa/setup` · `/2fa/enable` · `/2fa/disable` | two-step verification |
| `GET /api/sessions` · `DELETE /api/sessions/{id}` · `POST /api/sessions/revoke-others` · `POST /api/logout` | devices / sessions |
| `GET /api/storage` · `DELETE /api/media/{id}` · `POST /api/media/cleanup` | storage dashboard and cleanup |
| `POST /api/support` `{kind:"support"|"problem", message}` | save a support message |
| `GET /api/app-info` | version and support email |
Existing: `/api/login` now also accepts `code` (2FA).

## Render deployment
1. Replace/add the files above in your GitHub repo and push. Render redeploys.
2. Optional environment variables: `SUPPORT_EMAIL` (shown in Help), `APP_VERSION`. Existing `DATABASE_URL`, `SECRET_KEY`, `TURN_*` stay as they are.
3. Open the site once, log in again.

## Testing every setting (use two accounts, A and B, as friends)
1. **Privacy:** A sets *Last seen* = Nobody and *Profile photo* = My contacts except B → B opens A's chat: no last seen, no photo. Reset with *Default privacy settings*.
2. **Receipts/typing:** A turns *Read receipts* off, B sends a message, A opens it → B's tick stays grey. Turn *Typing indicators* off → no "typing…".
3. **Security:** A: Security › Set up, scan/enter the key, enter the code. Log out, log in → code requested. Log in on a second browser, then *Log out from other devices* → the other browser is logged out at once.
4. **Devices:** Linked devices lists both browsers with names and last-active time; log one out.
5. **Chats:** change theme/wallpaper/font size; with *Enter sends* off Enter adds a line; archive, mute, clear, delete a chat; download a backup.
6. **Notifications:** allow browser permission, send a message from B while A is in another chat or tab: sound + pop-up. Mute the chat → silent. Test sound button.
7. **Storage:** send a photo/video, open Storage and data: sizes shown; delete it; try bulk cleanup. Set Mobile data video off + Data saver on → videos show "tap to download".
8. **Profile:** change photo, name, about → Save; Cancel discards; Preview shows both views.
9. **Account:** change email/phone/password (wrong password is refused); download account info; delete a throw-away account.
10. **Accessibility:** font slider, high contrast, reduce animations; Tab through the page; Esc closes windows.
11. **Help:** FAQ, Report a problem → appears in `support_reports`.

## Things that need extra setup or are not included
- **Phone-number change** is not verified (needs an SMS provider). **Email verification / password reset by email** need an email service.
- **Status privacy:** the app has no Status/Stories feature, so no option is shown.
- **Free Render plan:** uploaded files vanish on redeploy; the storage page reports such files as missing. Use a Render Disk or cloud storage for permanent media.
- Privacy policy and terms are templates; have them reviewed before going public.
