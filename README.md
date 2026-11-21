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

---
# 🚫👥↩️ Block/Unblock, Group management, Group calls, Back navigation (v1.4.0)

## Folder structure
```
friends-chat/
├── backend/
│   ├── main.py            ← replace  (block rules, group_info table, group fields, group-call hooks)
│   ├── settings_api.py    ← replace  (app-info now reports if group calls are configured)
│   └── groups_api.py      ← NEW      (groups, members, admins, exit, delete, profiles, group-call signaling)
├── frontend/
│   ├── index.html, app.js, calls.js, settings.js  ← replace
│   ├── nav.js             ← NEW (History API router: Back / Android Back)
│   ├── groups.js          ← NEW (profile page, group info, block/unblock)
│   ├── gcall.js           ← NEW (group call screen)
│   ├── groups.css         ← NEW
│   └── settings.css, style.css  ← unchanged
├── render.yaml, README.md ← replace
```

## Database
One new table, created automatically on start (existing tables are not changed, nothing to migrate by hand):
`group_info(chat_id, description, avatar, created, owner_id, admins, edit_info, add_members)`.
Groups that existed before this update get their row the first time they are opened: the **earliest member becomes the owner** and the creation date shows as "unknown".
Group system messages ("X left", "X added Y") are normal rows in `messages` with `kind = 'system'`.

## Environment variables (Render → Environment)
| Variable | Needed for |
|---|---|
| `LIVEKIT_URL` | Group calls: your LiveKit address, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | Group calls: key of your LiveKit project |
| `LIVEKIT_API_SECRET` | Group calls: secret of your LiveKit project (keep private) |
Without these three, everything else works; group call buttons explain that a media server is missing. Existing `TURN_*`, `SUPPORT_EMAIL` etc. stay.

## Why group calls need extra infrastructure (SFU)
In a one-to-one call each browser sends video straight to the other. In a group of N people that means every browser would upload its video N-1 times, which collapses at about 4 people. An **SFU** (Selective Forwarding Unit) fixes this: each person uploads once to a media server, and the server forwards streams to the others.
Render web services only carry HTTP/WebSocket traffic and cannot run an SFU (it needs open UDP ports). So this project uses **LiveKit**, an open-source SFU:
1. Create a LiveKit project (LiveKit Cloud has a free tier; check its current limits) or self-host LiveKit on a VPS with open UDP ports.
2. Copy the project's WebSocket URL, API key and API secret into the 3 Render variables and redeploy.
3. How it works here: members tap the group call button → the Friends Chat server checks membership and sends a short-lived LiveKit join token over the existing WebSocket → the browser connects to LiveKit with the LiveKit JavaScript library (loaded from the jsDelivr CDN). **Audio/video never passes through FastAPI.**
Limit: a person removed from a group mid-call stays connected until their token ends (2 hours) because ending a LiveKit session from our server needs LiveKit's admin API, which is not wired up. They can no longer join new calls.

## Back navigation
Every screen has an address: `#/chat/5`, `#/settings`, `#/settings/privacy`, `#/profile/7`, `#/group/5`, `#/group/5/add`.
Opening a screen pushes a history entry (`pushState`); the browser Back button, Android Back and every ← button go to the previous screen (`popstate`). Examples: Settings → Privacy → Back = Settings → Back = Chats. Chat → friend profile → Back = that chat. Group → Group info → member profile → Back = Group info → Back = group chat.
Back also closes an open pop-up first, and does not leave a running call (it shows "Use End call"). Opening a link like `#/settings/privacy` builds the history so Back climbs one level at a time; if there is no earlier entry the ← button goes to the logical parent screen. Logout clears the address.

## API (all need `Authorization: Bearer <token>`)
| Method & path | Purpose |
|---|---|
| `POST /api/block` `{user_id}` · `POST /api/unblock` | block / unblock (one-way; also cancels pending requests and any running call) |
| `GET /api/blocked` | my blocked users |
| `GET /api/users/{id}` | profile (only friends, requests, or people sharing a group) |
| `GET /api/groups/{id}` | group info, members, roles, my permissions, call state |
| `PUT /api/groups/{id}` `{name, description, avatar}` | edit (admins, or everyone if allowed) |
| `PUT /api/groups/{id}/permissions` `{edit_info, add_members}` | `"admins"` or `"all"` (admins only) |
| `POST /api/groups/{id}/members` `{user_ids}` | add your own friends |
| `DELETE /api/groups/{id}/members/{uid}` | remove a member (admins; only the owner removes admins) |
| `POST /api/groups/{id}/admins` `{user_id, admin}` | promote / demote |
| `POST /api/groups/{id}/leave` | **Exit group** (only me) |
| `DELETE /api/groups/{id}` | **Delete group** for everyone (admins/owner) |
| WebSocket `gcall_start` / `gcall_join` / `gcall_leave` `{chat_id}` | group-call signaling; server answers `gcall_token`, `gcall_state`, `gcall_ring`, `gcall_error` |
| WebSocket events from server | `group_updated`, `group_removed` (`reason`: removed / left / deleted) |
Blocking is enforced on the server: messages, calls, friend requests and accepting requests are refused for a blocked pair, and a blocker's photo/about/online/last-seen are hidden from the blocked person. Blocking in a group chat does not stop group messages.

## Test checklist (accounts A, B, C; A and B and C are friends)
1. **Block:** A opens B's profile (tap B's name in the chat) → Block → confirm → button shows Unblock; the chat shows a "You blocked B" bar. Check Settings › Privacy › Blocked contacts lists B.
2. **Blocked sends:** B writes to A → B sees "You can't send messages to this contact"; A receives nothing. B calls A → "You cannot call this user". B sends A a friend request (after unfriending) → refused.
3. **Unblock:** A taps Unblock (confirm). Messaging and calls work again; B was never blocked by A's block of B in the other direction (A can unblock without B doing anything).
4. **Groups:** A creates a group with B and C → open the group → ℹ️ Group info. Edit name/description/photo, add a member, make B admin, remove C, set "who can add members" = All.
5. **Group voice call** (needs LiveKit): A taps 📞 → B and C get a Join popup → join, mute/unmute, see participant names and count, Leave. Last person leaving ends the call (a system message shows the duration).
6. **Group video call:** same with 🎥: tiles with names, camera on/off, speaking highlight.
7. **Exit group:** C → Exit group → confirm → C no longer sees the group or new messages; others see "C left".
8. **Delete group:** B (admin) → Delete group → confirm → everyone loses the group; opening `#/group/ID` shows nothing. A normal member sees the Delete option disabled with the reason.
9. **Back:** Chats → Settings → Privacy → Back, Back lands on Chats; Chat → profile → Back; Group → Group info → member → Back, Back; press Android Back with a pop-up open (closes it), during a call (stays), and after pasting a `#/settings/privacy` link.
10. Repeat on desktop and an Android phone.

## Render deployment
1. Upload the changed/new files to GitHub and push; Render redeploys and creates the `group_info` table.
2. For group calls add the three `LIVEKIT_*` variables, then redeploy.
3. Open the site over `https://` (needed for camera/microphone).
