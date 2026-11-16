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
