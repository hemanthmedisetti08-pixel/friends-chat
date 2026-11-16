"""Friends Chat backend (FastAPI + WebSockets).  Run:  uvicorn main:app --reload"""
import os, re, uuid, hashlib, hmac, secrets
from datetime import datetime, timedelta
import jwt
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, ForeignKey, Text, or_, func
from sqlalchemy.orm import declarative_base, sessionmaker

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

Base.metadata.create_all(engine)

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
def make_token(uid): return jwt.encode({"sub": str(uid), "exp": datetime.utcnow() + timedelta(days=7)}, SECRET, algorithm="HS256")
def read_token(t): return int(jwt.decode(t, SECRET, algorithms=["HS256"])["sub"])

app = FastAPI(title="Friends Chat")
bearer = HTTPBearer(auto_error=False)

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

def current_user(cred: HTTPAuthorizationCredentials = Depends(bearer), db=Depends(get_db)):
    try: u = db.get(User, read_token(cred.credentials))
    except Exception: u = None
    if not u: raise HTTPException(401, "Please log in again")
    return u

# ---------- Serializers & helpers ----------
def user_out(u): return dict(id=u.id, name=u.name, username=u.username, bio=u.bio or "", avatar=u.avatar or "", online=u.online, last_seen=u.last_seen.isoformat() + "Z")
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
class Login(BaseModel): email: str; password: str
class ProfileIn(BaseModel): name: str; username: str; bio: str = ""; avatar: str = ""
class IdIn(BaseModel): user_id: int
class RespondIn(BaseModel): request_id: int; accept: bool
class GroupIn(BaseModel): name: str; member_ids: list[int]

@app.post("/api/register")
def register(b: Register, db=Depends(get_db)):
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
    return {"token": make_token(u.id)}

@app.post("/api/login")
def login(b: Login, db=Depends(get_db)):
    u = db.query(User).filter_by(email=b.email.strip().lower()).first()
    if not u or not check_pw(b.password, u.password_hash): raise HTTPException(401, "Wrong email or password")
    return {"token": make_token(u.id)}

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
    return [dict(user_out(u), relation=relation(db, me.id, u.id)) for u in rows if not is_blocked(db, me.id, u.id)]

@app.post("/api/friends/request")
async def friend_request(b: IdIn, me=Depends(current_user), db=Depends(get_db)):
    if b.user_id == me.id or not db.get(User, b.user_id): raise HTTPException(400, "Invalid user")
    if is_blocked(db, me.id, b.user_id): raise HTTPException(403, "You can't send a request to this user")
    if relation(db, me.id, b.user_id) != "none": raise HTTPException(400, "Request already exists")
    db.add(Friendship(from_id=me.id, to_id=b.user_id)); db.commit()
    await mgr.send(b.user_id, {"type": "friend_request", "user": user_out(me)})
    return {"ok": True}

@app.get("/api/friends/requests")
def requests_in(me=Depends(current_user), db=Depends(get_db)):
    rows = db.query(Friendship).filter_by(to_id=me.id, status="pending").all()
    return [dict(id=r.id, user=user_out(db.get(User, r.from_id))) for r in rows]

@app.post("/api/friends/respond")
async def respond(b: RespondIn, me=Depends(current_user), db=Depends(get_db)):
    f = db.get(Friendship, b.request_id)
    if not f or f.to_id != me.id or f.status != "pending": raise HTTPException(404, "Request not found")
    if b.accept:
        f.status = "accepted"
        chat = Chat(is_group=False); db.add(chat); db.flush()
        db.add_all([Member(chat_id=chat.id, user_id=f.from_id), Member(chat_id=chat.id, user_id=f.to_id)])
        db.commit()
        await mgr.send(f.from_id, {"type": "friend_accepted", "user": user_out(me)})
    else:
        db.delete(f); db.commit()
    return {"ok": True}

@app.get("/api/friends")
def friends(me=Depends(current_user), db=Depends(get_db)):
    return [user_out(db.get(User, i)) for i in friend_ids(db, me.id)]

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
    return [user_out(db.get(User, r.blocked_id)) for r in db.query(Block).filter_by(user_id=me.id)]

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
    out = []
    for mem in db.query(Member).filter_by(user_id=me.id):
        c = db.get(Chat, mem.chat_id)
        users = [db.get(User, m.user_id) for m in db.query(Member).filter_by(chat_id=c.id)]
        other = None if c.is_group else next((u for u in users if u.id != me.id), None)
        last = db.query(Message).filter_by(chat_id=c.id).order_by(Message.id.desc()).first()
        unread = db.query(func.count(Message.id)).filter(Message.chat_id == c.id, Message.id > mem.last_read_id, Message.sender_id != me.id).scalar()
        out.append(dict(id=c.id, is_group=c.is_group, name=c.name if c.is_group else (other.name if other else "Deleted user"),
                        avatar="" if c.is_group or not other else other.avatar, other=user_out(other) if other else None,
                        members=[user_out(u) for u in users], last=msg_out(last) if last else None, unread=unread))
    out.sort(key=lambda c: (c["last"] or {}).get("created", ""), reverse=True)
    return out

@app.get("/api/chats/{chat_id}/messages")
def history(chat_id: int, me=Depends(current_user), db=Depends(get_db)):
    if not db.query(Member).filter_by(chat_id=chat_id, user_id=me.id).first(): raise HTTPException(403, "Not your chat")
    rows = db.query(Message).filter_by(chat_id=chat_id).order_by(Message.id.desc()).limit(200).all()
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

# ---------- WebSocket (real-time) ----------
async def broadcast_presence(db, user):
    for fid in friend_ids(db, user.id): await mgr.send(fid, {"type": "presence", "user": user_out(user)})

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
        for m in db.query(Message).filter(Message.chat_id == cid, Message.sender_id != uid, Message.status != "read"):
            m.status = "read"; groups.setdefault(m.sender_id, []).append(m.id)
        db.commit()
        for sid, ids in groups.items(): await mgr.send(sid, {"type": "status", "chat_id": cid, "ids": ids, "status": "read"})

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str):
    try: uid = read_token(token)
    except Exception: await ws.close(code=4401); return
    await ws.accept()
    db = SessionLocal(); user = db.get(User, uid)
    if not user: await ws.close(code=4401); return
    mgr.conns.setdefault(uid, set()).add(ws)
    user.online = True; db.commit()
    await broadcast_presence(db, user); await mark_delivered(db, uid)
    try:
        while True:
            data = await ws.receive_json()
            try: await handle_ws(db, uid, data)
            except WebSocketDisconnect: raise
            except Exception: db.rollback()
    except Exception: pass
    finally:
        mgr.conns[uid].discard(ws)
        if not mgr.conns[uid]:
            user = db.get(User, uid); user.online = False; user.last_seen = datetime.utcnow(); db.commit()
            await broadcast_presence(db, user)
        db.close()

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR))
app.mount("/", StaticFiles(directory=os.path.join(BASE, "..", "frontend"), html=True))
