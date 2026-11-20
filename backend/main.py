"""Friends Chat backend (FastAPI + WebSockets).  Run:  uvicorn main:app --reload"""
import os, re, uuid, hashlib, hmac, secrets, asyncio, base64, json, time, struct
from datetime import datetime, timedelta
import jwt
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, ForeignKey, Text, or_, func
from sqlalchemy.orm import declarative_base, sessionmaker, object_session

BASE = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE, "uploads"); os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------- Database (SQLite by default; set DATABASE_URL for PostgreSQL) ----------
DB_URL = os.getenv("DATABASE_URL", "sqlite:///" + os.path.join(BASE, "chat.db"))
if DB_URL.startswith("postgres://"): DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DB_URL.startswith("postgresql://"): DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg2://", 1)
engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String(80)); email = Column(String(120), unique=True, index=True)
    phone = Column(String(30)); username = Column(String(40), unique=True, index=True)
    password_hash = Column(String(200)); bio = Column(String(200), default="")
    avatar = Column(String(200), default=""); online = Column(Boolean, default=False)
    last_seen = Column(DateTime, default=datetime.utcnow)

class Friendship(Base):
    __tablename__ = "friendships"
    id = Column(Integer, primary_key=True)
    from_id = Column(Integer, ForeignKey("users.id")); to_id = Column(Integer, ForeignKey("users.id"))
    status = Column(String(10), default="pending")  # pending | accepted

class Block(Base):
    __tablename__ = "blocks"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id")); blocked_id = Column(Integer, ForeignKey("users.id"))

class Chat(Base):
    __tablename__ = "chats"
    id = Column(Integer, primary_key=True)
    name = Column(String(80), default=""); is_group = Column(Boolean, default=False)

class Member(Base):
    __tablename__ = "members"
    id = Column(Integer, primary_key=True)
    chat_id = Column(Integer, ForeignKey("chats.id"), index=True); user_id = Column(Integer, ForeignKey("users.id"), index=True)
    last_read_id = Column(Integer, default=0)

class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True)
    chat_id = Column(Integer, ForeignKey("chats.id"), index=True); sender_id = Column(Integer, ForeignKey("users.id"))
    kind = Column(String(10), default="text")  # text | image | video | audio | file
    body = Column(Text, default=""); file_url = Column(String(200), default=""); file_name = Column(String(120), default="")
    status = Column(String(10), default="sent")  # sent | delivered | read
    created = Column(DateTime, default=datetime.utcnow)

class CallLog(Base):  # call history only - NO audio/video is ever stored
    __tablename__ = "call_logs"
    id = Column(Integer, primary_key=True)
    caller_id = Column(Integer, ForeignKey("users.id"), index=True); receiver_id = Column(Integer, ForeignKey("users.id"), index=True)
    call_type = Column(String(10))  # audio | video
    status = Column(String(12), default="ringing")  # ringing | completed | missed | rejected | cancelled | failed
    started = Column(DateTime, default=datetime.utcnow)
    connected_at = Column(DateTime, nullable=True); ended = Column(DateTime, nullable=True)
    duration = Column(Integer, default=0)  # seconds

class UserSettings(Base):  # ONE row per user: preferences as JSON + two-step verification secret
    __tablename__ = "user_settings"
    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    data = Column(Text, default="{}")
    totp_secret = Column(String(64), default=""); totp_enabled = Column(Boolean, default=False)

class LoginSession(Base):  # one row per logged-in device/browser
    __tablename__ = "login_sessions"
    id = Column(String(40), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    device = Column(String(120), default=""); ip = Column(String(64), default="")
    created = Column(DateTime, default=datetime.utcnow); last_active = Column(DateTime, default=datetime.utcnow)
    revoked = Column(Boolean, default=False)

class SupportReport(Base):  # "Contact support" / "Report a problem" messages
    __tablename__ = "support_reports"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True); kind = Column(String(10))
    message = Column(Text); user_agent = Column(String(200), default="")
    created = Column(DateTime, default=datetime.utcnow); status = Column(String(10), default="open")

Base.metadata.create_all(engine)  # only creates MISSING tables, so your existing data is untouched

# ---------- Security helpers ----------
def get_secret():
    if os.getenv("SECRET_KEY"): return os.getenv("SECRET_KEY")
    p = os.path.join(BASE, ".secret")
    if not os.path.exists(p): open(p, "w").write(secrets.token_hex(32))
    return open(p).read().strip()
SECRET = get_secret()

def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    return f"{salt}${hashlib.pbkdf2_hmac('sha256', pw.encode(), salt.encode(), 200_000).hex()}"
def check_pw(pw, stored): return hmac.compare_digest(hash_pw(pw, stored.split('$')[0]), stored)
def make_token(uid, sid): return jwt.encode({"sub": str(uid), "sid": sid, "exp": datetime.utcnow() + timedelta(days=7)}, SECRET, algorithm="HS256")
def read_claims(t):
    p = jwt.decode(t, SECRET, algorithms=["HS256"]); return int(p["sub"]), p["sid"]   # old tokens have no "sid" -> rejected, user logs in again
def read_token(t): return read_claims(t)[0]

app = FastAPI(title="Friends Chat")
bearer = HTTPBearer(auto_error=False)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

def auth_session(cred, db):
    try: uid, sid = read_claims(cred.credentials)
    except Exception: raise HTTPException(401, "Please log in again")
    s = db.get(LoginSession, sid); u = db.get(User, uid)
    if not s or not u or s.revoked or s.user_id != uid: raise HTTPException(401, "This device was logged out. Please log in again")
    if (datetime.utcnow() - s.last_active).total_seconds() > 60: s.last_active = datetime.utcnow(); db.commit()
    return u, s

def current_user(cred: HTTPAuthorizationCredentials = Depends(bearer), db=Depends(get_db)): return auth_session(cred, db)[0]
def current_session(cred: HTTPAuthorizationCredentials = Depends(bearer), db=Depends(get_db)): return auth_session(cred, db)[1]

# ---------- Serializers & helpers ----------
DEFAULTS = {
    "privacy": {"last_seen": "everyone", "last_seen_except": [], "online": "everyone", "online_except": [], "photo": "everyone", "photo_except": [],
                "about": "everyone", "about_except": [], "read_receipts": True, "typing": True},
    "security": {"alerts": True},
    "chat": {"theme": "system", "wallpaper": "default", "font_size": "medium", "enter_send": True, "list_preview": True},
    "media": {"mobile": {"image": True, "audio": True, "video": False, "file": False}, "wifi": {"image": True, "audio": True, "video": True, "file": True}, "data_saver": False},
    "notif": {"messages": True, "groups": True, "calls": True, "sound": "chime", "preview": True, "desktop": True, "vibrate": True},
    "access": {"font_scale": 100, "high_contrast": False, "reduce_motion": False},
    "chat_prefs": {},   # per-chat: archived, muted_until, cleared_before, hidden
}
def deep_merge(base, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict): deep_merge(base[k], v)
        else: base[k] = v
    return base
def get_settings(db, uid):
    r = db.get(UserSettings, uid)
    try: saved = json.loads(r.data or "{}") if r else {}
    except Exception: saved = {}
    return deep_merge(json.loads(json.dumps(DEFAULTS)), saved)
def allowed(s, field, is_contact, viewer_id=None):
    """Privacy rule: may a viewer see this field? (everyone / contacts / contacts_except / nobody)"""
    p = s["privacy"]; mode = p[field]
    if mode == "everyone": return True
    if mode == "nobody" or not is_contact: return False
    return mode == "contacts" or viewer_id not in p.get(field + "_except", [])
def user_out(u, viewer=None):
    d = dict(id=u.id, name=u.name, username=u.username, bio=u.bio or "", avatar=u.avatar or "", online=u.online, last_seen=u.last_seen.isoformat() + "Z")
    if viewer is not None and viewer != u.id:       # apply the owner's privacy settings for this viewer
        db = object_session(u); s = get_settings(db, u.id); f = find_friendship(db, viewer, u.id); contact = bool(f and f.status == "accepted")
        if not allowed(s, "photo", contact, viewer): d["avatar"] = ""
        if not allowed(s, "about", contact, viewer): d["bio"] = ""
        if not allowed(s, "online", contact, viewer): d["online"] = False
        if not allowed(s, "last_seen", contact, viewer): d["last_seen"] = None
    return d

# ----- two-step verification (TOTP, RFC 6238; works with Google Authenticator, Microsoft Authenticator, Authy...) -----
def new_totp_secret(): return base64.b32encode(secrets.token_bytes(10)).decode()
def totp(secret, t):
    h = hmac.new(base64.b32decode(secret), struct.pack(">Q", int(t // 30)), hashlib.sha1).digest(); o = h[-1] & 15
    return str((struct.unpack(">I", h[o:o + 4])[0] & 0x7fffffff) % 1000000).zfill(6)
def verify_totp(secret, code):
    code = (code or "").strip().replace(" ", "")
    return bool(secret) and any(hmac.compare_digest(totp(secret, time.time() + d * 30), code) for d in (-1, 0, 1))

# ----- brute-force protection, device names, sessions, security alerts -----
attempts = {}
def check_throttle(key, limit=8, window=600):
    attempts[key] = [t for t in attempts.get(key, []) if time.time() - t < window]
    if len(attempts[key]) >= limit: raise HTTPException(429, "Too many attempts. Please wait a few minutes.")
def add_fail(key): attempts.setdefault(key, []).append(time.time())
def client_ip(request): return (request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else ""))[:64]
def device_info(request):
    ua = request.headers.get("user-agent", "")
    br = next((n for k, n in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")) if k in ua), "Browser")
    os_ = next((n for k, n in (("Android", "Android"), ("iPhone", "iOS"), ("iPad", "iOS"), ("Windows", "Windows"), ("Mac OS", "macOS"), ("Linux", "Linux")) if k in ua), "unknown OS")
    return f"{br} on {os_}"
def new_session(db, uid, request):
    s = LoginSession(id=secrets.token_hex(16), user_id=uid, device=device_info(request), ip=client_ip(request)); db.add(s); db.commit(); return s
async def security_alert(db, uid, text):
    if get_settings(db, uid)["security"]["alerts"]: await mgr.send(uid, {"type": "security", "text": text})
def msg_out(m): return dict(id=m.id, chat_id=m.chat_id, sender_id=m.sender_id, kind=m.kind, body=m.body, file_url=m.file_url, file_name=m.file_name, status=m.status, created=m.created.isoformat() + "Z")

def is_blocked(db, a, b):
    return db.query(Block).filter(or_((Block.user_id == a) & (Block.blocked_id == b), (Block.user_id == b) & (Block.blocked_id == a))).first() is not None

def find_friendship(db, a, b):
    return db.query(Friendship).filter(or_((Friendship.from_id == a) & (Friendship.to_id == b), (Friendship.from_id == b) & (Friendship.to_id == a))).first()

def relation(db, a, b):
    f = find_friendship(db, a, b)
    if not f: return "none"
    return "friend" if f.status == "accepted" else ("sent" if f.from_id == a else "received")

def friend_ids(db, uid):
    rows = db.query(Friendship).filter(Friendship.status == "accepted", or_(Friendship.from_id == uid, Friendship.to_id == uid)).all()
    return [r.to_id if r.from_id == uid else r.from_id for r in rows]

class Manager:  # tracks live WebSocket connections per user
    def __init__(self): self.conns = {}
    def online(self, uid): return bool(self.conns.get(uid))
    async def send(self, uid, data):
        for ws in list(self.conns.get(uid, [])):
            try: await ws.send_json(data)
            except Exception: self.conns[uid].discard(ws)
mgr = Manager()

# ---------- Auth & profile ----------
class Register(BaseModel): name: str; email: str; phone: str; password: str
class Login(BaseModel): email: str; password: str; code: str = ""
class ProfileIn(BaseModel): name: str; username: str; bio: str = ""; avatar: str = ""
class IdIn(BaseModel): user_id: int
class RespondIn(BaseModel): request_id: int; accept: bool
class GroupIn(BaseModel): name: str; member_ids: list[int]

@app.post("/api/register")
def register(b: Register, request: Request, db=Depends(get_db)):
    email = b.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email): raise HTTPException(400, "Enter a valid email")
    if not re.match(r"^\+?[0-9 \-]{7,20}$", b.phone.strip()): raise HTTPException(400, "Enter a valid phone number")
    if len(b.password) < 8: raise HTTPException(400, "Password must be at least 8 characters")
    if not b.name.strip(): raise HTTPException(400, "Name is required")
    if db.query(User).filter_by(email=email).first(): raise HTTPException(400, "Email already registered")
    base = re.sub(r"\W", "", b.name.lower())[:20] or "user"
    username = base
    while db.query(User).filter_by(username=username).first(): username = f"{base}{secrets.randbelow(9000) + 1000}"
    u = User(name=b.name.strip()[:80], email=email, phone=b.phone.strip(), username=username, password_hash=hash_pw(b.password))
    db.add(u); db.commit()
    return {"token": make_token(u.id, new_session(db, u.id, request).id)}

@app.post("/api/login")
async def login(b: Login, request: Request, db=Depends(get_db)):
    email = b.email.strip().lower(); key = f"login|{email}|{client_ip(request)}"; check_throttle(key)
    u = db.query(User).filter_by(email=email).first()
    if not u or not check_pw(b.password, u.password_hash): add_fail(key); raise HTTPException(401, "Wrong email or password")
    st = db.get(UserSettings, u.id)
    if st and st.totp_enabled:
        if not b.code.strip(): raise HTTPException(401, "2FA_REQUIRED")
        if not verify_totp(st.totp_secret, b.code): add_fail(key); raise HTTPException(401, "Wrong verification code")
    attempts.pop(key, None)
    s = new_session(db, u.id, request)
    await security_alert(db, u.id, f"New login from {s.device}")
    return {"token": make_token(u.id, s.id)}

@app.get("/api/me")
def me_get(me=Depends(current_user)): return user_out(me)

@app.put("/api/me")
def me_put(b: ProfileIn, me=Depends(current_user), db=Depends(get_db)):
    un = b.username.strip().lower()
    if not re.match(r"^[a-z0-9_]{3,30}$", un): raise HTTPException(400, "Username: 3-30 letters, numbers or _")
    other = db.query(User).filter_by(username=un).first()
    if other and other.id != me.id: raise HTTPException(400, "Username already taken")
    if not b.avatar or b.avatar.startswith("/uploads/"): me.avatar = b.avatar
    me.name, me.username, me.bio = b.name.strip()[:80] or me.name, un, b.bio[:200]
    db.commit(); return user_out(me)

# ---------- Friends & blocking ----------
@app.get("/api/users/search")
def search(q: str, me=Depends(current_user), db=Depends(get_db)):
    q = q.strip().lstrip("@")
    if len(q) < 2: return []
    rows = db.query(User).filter(User.id != me.id, or_(User.username.ilike(f"%{q}%"), User.name.ilike(f"%{q}%"))).limit(20).all()
    return [dict(user_out(u, me.id), relation=relation(db, me.id, u.id)) for u in rows if not is_blocked(db, me.id, u.id)]

@app.post("/api/friends/request")
async def friend_request(b: IdIn, me=Depends(current_user), db=Depends(get_db)):
    if b.user_id == me.id or not db.get(User, b.user_id): raise HTTPException(400, "Invalid user")
    if is_blocked(db, me.id, b.user_id): raise HTTPException(403, "You can't send a request to this user")
    if relation(db, me.id, b.user_id) != "none": raise HTTPException(400, "Request already exists")
    db.add(Friendship(from_id=me.id, to_id=b.user_id)); db.commit()
    await mgr.send(b.user_id, {"type": "friend_request", "user": user_out(me, b.user_id)})
    return {"ok": True}

@app.get("/api/friends/requests")
def requests_in(me=Depends(current_user), db=Depends(get_db)):
    rows = db.query(Friendship).filter_by(to_id=me.id, status="pending").all()
    return [dict(id=r.id, user=user_out(db.get(User, r.from_id), me.id)) for r in rows]

@app.post("/api/friends/respond")
async def respond(b: RespondIn, me=Depends(current_user), db=Depends(get_db)):
    f = db.get(Friendship, b.request_id)
    if not f or f.to_id != me.id or f.status != "pending": raise HTTPException(404, "Request not found")
    if b.accept:
        f.status = "accepted"
        chat = Chat(is_group=False); db.add(chat); db.flush()
        db.add_all([Member(chat_id=chat.id, user_id=f.from_id), Member(chat_id=chat.id, user_id=f.to_id)])
        db.commit()
        await mgr.send(f.from_id, {"type": "friend_accepted", "user": user_out(me, f.from_id)})
    else:
        db.delete(f); db.commit()
    return {"ok": True}

@app.get("/api/friends")
def friends(me=Depends(current_user), db=Depends(get_db)):
    return [user_out(db.get(User, i), me.id) for i in friend_ids(db, me.id)]

@app.post("/api/block")
def block(b: IdIn, me=Depends(current_user), db=Depends(get_db)):
    if not db.query(Block).filter_by(user_id=me.id, blocked_id=b.user_id).first():
        db.add(Block(user_id=me.id, blocked_id=b.user_id)); db.commit()
    return {"ok": True}

@app.post("/api/unblock")
def unblock(b: IdIn, me=Depends(current_user), db=Depends(get_db)):
    db.query(Block).filter_by(user_id=me.id, blocked_id=b.user_id).delete(); db.commit(); return {"ok": True}

@app.get("/api/blocked")
def blocked_list(me=Depends(current_user), db=Depends(get_db)):
    return [user_out(db.get(User, r.blocked_id), me.id) for r in db.query(Block).filter_by(user_id=me.id)]

# ---------- Chats, groups, messages, uploads ----------
@app.post("/api/groups")
async def make_group(b: GroupIn, me=Depends(current_user), db=Depends(get_db)):
    ids = set(b.member_ids) & set(friend_ids(db, me.id))
    if not b.name.strip() or not ids: raise HTTPException(400, "Give the group a name and pick at least one friend")
    chat = Chat(name=b.name.strip()[:80], is_group=True); db.add(chat); db.flush()
    db.add_all([Member(chat_id=chat.id, user_id=i) for i in ids | {me.id}]); db.commit()
    for i in ids: await mgr.send(i, {"type": "chat_created"})
    return {"id": chat.id}

@app.get("/api/chats")
def chats(me=Depends(current_user), db=Depends(get_db)):
    prefs = get_settings(db, me.id)["chat_prefs"]; out = []
    for mem in db.query(Member).filter_by(user_id=me.id):
        c = db.get(Chat, mem.chat_id); p = prefs.get(str(c.id), {}); cleared = p.get("cleared_before", 0)
        users = [db.get(User, m.user_id) for m in db.query(Member).filter_by(chat_id=c.id)]
        other = None if c.is_group else next((u for u in users if u.id != me.id), None)
        last = db.query(Message).filter(Message.chat_id == c.id, Message.id > cleared).order_by(Message.id.desc()).first()
        if p.get("hidden") and not last: continue          # chat was deleted by me and nothing new arrived
        unread = db.query(func.count(Message.id)).filter(Message.chat_id == c.id, Message.id > max(mem.last_read_id, cleared), Message.sender_id != me.id).scalar()
        out.append(dict(id=c.id, is_group=c.is_group, name=c.name if c.is_group else (other.name if other else "Deleted user"),
                        avatar="" if c.is_group or not other else user_out(other, me.id)["avatar"], other=user_out(other, me.id) if other else None,
                        members=[user_out(u, me.id) for u in users], last=msg_out(last) if last else None, unread=unread,
                        archived=bool(p.get("archived")), muted_until=p.get("muted_until", "")))
    out.sort(key=lambda c: (c["last"] or {}).get("created", ""), reverse=True)
    return out

@app.get("/api/chats/{chat_id}/messages")
def history(chat_id: int, me=Depends(current_user), db=Depends(get_db)):
    if not db.query(Member).filter_by(chat_id=chat_id, user_id=me.id).first(): raise HTTPException(403, "Not your chat")
    cleared = get_settings(db, me.id)["chat_prefs"].get(str(chat_id), {}).get("cleared_before", 0)
    rows = db.query(Message).filter(Message.chat_id == chat_id, Message.id > cleared).order_by(Message.id.desc()).limit(200).all()
    return [msg_out(m) for m in reversed(rows)]

@app.post("/api/upload")
async def upload(file: UploadFile = File(...), me=Depends(current_user)):
    data = await file.read()
    if len(data) > 25 * 1024 * 1024: raise HTTPException(413, "File too large (max 25 MB)")
    ext = os.path.splitext(file.filename or "")[1].lower()[:10]
    if ext in {".html", ".htm", ".js", ".svg", ".exe", ".bat", ".sh", ".php"}: raise HTTPException(400, "This file type is not allowed")
    name = uuid.uuid4().hex + ext
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f: f.write(data)
    ct = file.content_type or ""
    kind = "image" if ct.startswith("image/") else "video" if ct.startswith("video/") else "audio" if ct.startswith("audio/") else "file"
    return dict(url="/uploads/" + name, kind=kind, name=file.filename or name)

# ---------- Voice / video calls: WebRTC SIGNALING only (media goes browser-to-browser) ----------
calls, in_call = {}, {}   # calls[call_id] = state dict;  in_call[user_id] = call_id (to know who is busy)
RING_SECONDS, CONNECT_SECONDS = 45, 60

@app.get("/api/ice")
def ice_servers(me=Depends(current_user)):
    """STUN/TURN settings for WebRTC. TURN secrets live in environment variables, never in frontend code."""
    servers = [{"urls": [u.strip() for u in os.getenv("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302").split(",") if u.strip()]}]
    turn = [u.strip() for u in os.getenv("TURN_URLS", "").split(",") if u.strip()]
    if turn:
        secret = os.getenv("TURN_SECRET")  # option A: coturn "use-auth-secret" -> short-lived credentials
        if secret:
            username = f"{int(time.time()) + 3600}:{me.id}"
            cred = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
        else:  # option B: fixed username/credential from a TURN provider
            username, cred = os.getenv("TURN_USERNAME", ""), os.getenv("TURN_CREDENTIAL", "")
        servers.append({"urls": turn, "username": username, "credential": cred})
    return {"iceServers": servers}

@app.get("/api/calls")
def call_history(me=Depends(current_user), db=Depends(get_db)):
    rows = db.query(CallLog).filter(or_(CallLog.caller_id == me.id, CallLog.receiver_id == me.id)).order_by(CallLog.id.desc()).limit(10).all()
    out = []
    for r in rows:
        peer = db.get(User, r.receiver_id if r.caller_id == me.id else r.caller_id)
        out.append(dict(id=r.id, call_type=r.call_type, status=r.status, outgoing=r.caller_id == me.id, peer=peer.name if peer else "Deleted user",
                        started=r.started.isoformat() + "Z", duration=r.duration or 0))
    return out

async def end_call(db, cid, reason, by=None):
    """Close a call: free both users, save history, tell the other person. `by` = who ended it (not notified)."""
    c = calls.pop(cid, None)
    if not c: return
    for u in (c["caller"], c["callee"]): in_call.pop(u, None)
    t = c.get("task")
    if t and t is not asyncio.current_task(): t.cancel()
    now, connected = datetime.utcnow(), c["connected_at"] is not None
    if reason in ("rejected", "missed", "cancelled"): status = reason
    elif connected: status = "completed"
    else: status = "cancelled" if reason == "ended" else "failed"
    log = db.get(CallLog, c["log_id"])
    if log:
        log.status, log.ended, log.connected_at = status, now, c["connected_at"]
        log.duration = int((now - c["connected_at"]).total_seconds()) if connected else 0
        db.commit()
    for u in (c["caller"], c["callee"]):
        if u != by: await mgr.send(u, {"type": "call_ended", "call_id": cid, "reason": reason})

async def call_watchdog(cid, seconds, state, reason):
    """Safety net: if a call is stuck (nobody answers / never connects) close it so nobody stays 'busy' forever."""
    await asyncio.sleep(seconds)
    c = calls.get(cid)
    if c and c["state"] == state:
        db = SessionLocal()
        try: await end_call(db, cid, reason)
        finally: db.close()

async def handle_call(db, uid, data):
    t = data.get("type")
    if t == "call_invite":
        to, ctype = data.get("to"), data.get("call_type")
        async def fail(why): await mgr.send(uid, {"type": "call_failed", "reason": why})
        if ctype not in ("audio", "video") or not isinstance(to, int) or to == uid or not db.get(User, to): return await fail("invalid")
        f = find_friendship(db, uid, to)
        if not f or f.status != "accepted": return await fail("not_friends")     # only friends can call
        if is_blocked(db, uid, to): return await fail("blocked")
        if uid in in_call or to in in_call: return await fail("busy")
        if not mgr.online(to):
            db.add(CallLog(caller_id=uid, receiver_id=to, call_type=ctype, status="missed", ended=datetime.utcnow(), duration=0)); db.commit()
            return await fail("offline")
        log = CallLog(caller_id=uid, receiver_id=to, call_type=ctype); db.add(log); db.commit()
        cid = uuid.uuid4().hex
        calls[cid] = dict(caller=uid, callee=to, type=ctype, state="ringing", log_id=log.id, connected_at=None,
                          task=asyncio.create_task(call_watchdog(cid, RING_SECONDS, "ringing", "missed")))
        in_call[uid] = in_call[to] = cid
        await mgr.send(uid, {"type": "call_ringing", "call_id": cid})
        await mgr.send(to, {"type": "call_incoming", "call_id": cid, "call_type": ctype, "user": user_out(db.get(User, uid), to)})
        return
    cid = data.get("call_id"); c = calls.get(cid)
    if not c or uid not in (c["caller"], c["callee"]): return          # unknown call or not a participant -> ignore
    other = c["callee"] if uid == c["caller"] else c["caller"]
    if t == "call_accept" and uid == c["callee"] and c["state"] == "ringing":
        c["state"] = "connecting"
        if c.get("task"): c["task"].cancel()
        c["task"] = asyncio.create_task(call_watchdog(cid, CONNECT_SECONDS, "connecting", "failed"))
        await mgr.send(other, {"type": "call_accepted", "call_id": cid})
    elif t == "call_reject" and uid == c["callee"] and c["state"] == "ringing":
        await end_call(db, cid, "rejected", by=uid)
    elif t == "call_end":
        await end_call(db, cid, "cancelled" if c["state"] == "ringing" else "ended", by=uid)
    elif t == "call_connected" and c["state"] == "connecting":
        c["state"] = "connected"; c["connected_at"] = datetime.utcnow()
        if c.get("task"): c["task"].cancel()
    elif t == "call_signal" and c["state"] in ("connecting", "connected"):
        sig = data.get("data")
        if isinstance(sig, dict) and len(json.dumps(sig)) < 20000:       # forward offer / answer / ICE to the other person only
            await mgr.send(other, {"type": "call_signal", "call_id": cid, "data": sig})

# ---------- WebSocket (real-time) ----------
async def broadcast_presence(db, user):
    for fid in friend_ids(db, user.id): await mgr.send(fid, {"type": "presence", "user": user_out(user, fid)})

async def mark_delivered(db, uid):
    cids = [m.chat_id for m in db.query(Member).filter_by(user_id=uid)]
    if not cids: return
    groups = {}
    for m in db.query(Message).filter(Message.chat_id.in_(cids), Message.sender_id != uid, Message.status == "sent"):
        m.status = "delivered"; groups.setdefault((m.sender_id, m.chat_id), []).append(m.id)
    db.commit()
    for (sid, cid), ids in groups.items(): await mgr.send(sid, {"type": "status", "chat_id": cid, "ids": ids, "status": "delivered"})

async def handle_ws(db, uid, data):
    cid = data.get("chat_id")
    mem = db.query(Member).filter_by(chat_id=cid, user_id=uid).first()
    if not mem: return
    chat = db.get(Chat, cid)
    others = [m.user_id for m in db.query(Member).filter(Member.chat_id == cid, Member.user_id != uid)]
    if data.get("type") == "message":
        kind = data.get("kind", "text"); body = (data.get("body") or "").strip()[:4000]; url = data.get("file_url") or ""
        if kind not in ("text", "image", "video", "audio", "file"): return
        if kind == "text" and not body: return
        if kind != "text" and not url.startswith("/uploads/"): return
        if not chat.is_group and any(is_blocked(db, uid, o) for o in others):
            await mgr.send(uid, {"type": "error", "detail": "Message not sent: user is blocked"}); return
        m = Message(chat_id=cid, sender_id=uid, kind=kind, body=body, file_url=url, file_name=(data.get("file_name") or "")[:120])
        db.add(m); db.commit()
        if any(mgr.online(o) for o in others): m.status = "delivered"
        mem.last_read_id = m.id; db.commit()
        for u in [uid] + others: await mgr.send(u, {"type": "message", "message": msg_out(m)})
    elif data.get("type") == "read":
        mem.last_read_id = db.query(func.max(Message.id)).filter_by(chat_id=cid).scalar() or 0
        groups = {}
        if get_settings(db, uid)["privacy"]["read_receipts"]:      # receipts OFF -> sender never sees blue ticks
            for m in db.query(Message).filter(Message.chat_id == cid, Message.sender_id != uid, Message.status != "read"):
                m.status = "read"; groups.setdefault(m.sender_id, []).append(m.id)
        db.commit()
        for sid, ids in groups.items(): await mgr.send(sid, {"type": "status", "chat_id": cid, "ids": ids, "status": "read"})
    elif data.get("type") == "typing":
        if not chat.is_group and any(is_blocked(db, uid, o) for o in others): return
        if get_settings(db, uid)["privacy"]["typing"]:
            for o in others:
                if get_settings(db, o)["privacy"]["typing"]: await mgr.send(o, {"type": "typing", "chat_id": cid, "user_id": uid})

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str):
    await ws.accept()
    db = SessionLocal(); uid = s = None
    try: uid, sid = read_claims(token); s = db.get(LoginSession, sid)
    except Exception: pass
    user = db.get(User, uid) if s and not s.revoked and s.user_id == uid else None
    if not user: db.close(); await ws.close(code=4401); return
    ws.state.sid = sid
    mgr.conns.setdefault(uid, set()).add(ws)
    user.online = True; db.commit()
    await broadcast_presence(db, user); await mark_delivered(db, uid)
    try:
        while True:
            data = await ws.receive_json()
            try: await (handle_call(db, uid, data) if str(data.get("type", "")).startswith("call_") else handle_ws(db, uid, data))
            except WebSocketDisconnect: raise
            except Exception: db.rollback()
    except Exception: pass
    finally:
        mgr.conns[uid].discard(ws)
        if not mgr.conns[uid]:
            user = db.get(User, uid); user.online = False; user.last_seen = datetime.utcnow(); db.commit()
            if uid in in_call: await end_call(db, in_call[uid], "disconnected", by=uid)  # hang up if the user vanished
            await broadcast_presence(db, user)
        db.close()

from settings_api import router as settings_router  # settings / account / security endpoints (new file)
app.include_router(settings_router)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR))
app.mount("/", StaticFiles(directory=os.path.join(BASE, "..", "frontend"), html=True))
