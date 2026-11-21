"""Settings, account, security, sessions, storage and support endpoints.
Imported at the bottom of main.py:  app.include_router(router)   (all routes start with /api)"""
import os, re, json
from datetime import datetime, timedelta
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, or_
from main import (get_db, current_user, current_session, User, Friendship, Block, Chat, Member, Message, CallLog, LoginSession, UserSettings,
                  SupportReport, get_settings, allowed, user_out, mgr, friend_ids, check_pw, hash_pw, check_throttle, add_fail, verify_totp,
                  new_totp_secret, security_alert, UPLOAD_DIR, in_call, end_call)

router = APIRouter(prefix="/api")
VIS = ("everyone", "contacts", "contacts_except", "nobody")

# ---------- which settings exist and which values are allowed (everything else is rejected) ----------
RULES = {}
for _k in ("last_seen", "online", "photo", "about"): RULES["privacy." + _k] = VIS
for _k in ("read_receipts", "typing"): RULES["privacy." + _k] = bool
for _k in ("messages", "groups", "calls", "preview", "desktop", "vibrate"): RULES["notif." + _k] = bool
for _n in ("mobile", "wifi"):
    for _t in ("image", "audio", "video", "file"): RULES[f"media.{_n}.{_t}"] = bool
RULES.update({"security.alerts": bool, "chat.theme": ("light", "dark", "system"), "chat.wallpaper": "wall", "chat.font_size": ("small", "medium", "large"),
              "chat.enter_send": bool, "chat.list_preview": bool, "media.data_saver": bool, "notif.sound": ("chime", "beep", "pop", "none"),
              "access.font_scale": ("range", 80, 150), "access.high_contrast": bool, "access.reduce_motion": bool})

def clean(key, v, friends):
    if re.fullmatch(r"privacy\.(last_seen|online|photo|about)_except", key):
        if not isinstance(v, list) or len(v) > 300: raise HTTPException(400, "Invalid list")
        return [i for i in v if isinstance(i, int) and i in friends]
    r = RULES.get(key)
    if r is None: raise HTTPException(400, f"Unknown setting: {key}")
    if r is bool:
        if not isinstance(v, bool): raise HTTPException(400, "Must be on or off")
        return v
    if r == "wall":
        if isinstance(v, str) and re.fullmatch(r"default|preset:[a-z0-9\-]{1,20}|color:#[0-9a-fA-F]{6}|url:/uploads/[A-Za-z0-9_.\-]{1,80}", v): return v
        raise HTTPException(400, "Invalid wallpaper")
    if r[0] == "range":
        if isinstance(v, int) and not isinstance(v, bool) and r[1] <= v <= r[2]: return v
        raise HTTPException(400, f"Value must be between {r[1]} and {r[2]}")
    if isinstance(v, str) and v in r: return v
    raise HTTPException(400, f"Invalid value for {key}")

def settings_row(db, uid):
    r = db.get(UserSettings, uid)
    if not r: r = UserSettings(user_id=uid, data="{}"); db.add(r); db.flush()
    return r
def load(r):
    try: return json.loads(r.data or "{}")
    except Exception: return {}
def set_path(d, parts, v):
    for p in parts[:-1]: d = d.setdefault(p, {})
    d[parts[-1]] = v
def edit_prefs(db, uid, cid, **changes):
    r = settings_row(db, uid); d = load(r); d.setdefault("chat_prefs", {}).setdefault(str(cid), {}).update(changes); r.data = json.dumps(d); db.commit()
def member_of(db, uid, cid):
    m = db.query(Member).filter_by(chat_id=cid, user_id=uid).first()
    if not m: raise HTTPException(404, "Chat not found")
    return m
def need_password(db, me, pw):
    key = f"pw|{me.id}"; check_throttle(key)
    if not check_pw(pw or "", me.password_hash): add_fail(key); raise HTTPException(403, "Wrong password")
def remove_file(url):
    if url and url.startswith("/uploads/"):
        try: os.remove(os.path.join(UPLOAD_DIR, os.path.basename(url)))
        except OSError: pass
def file_size(url):
    p = os.path.join(UPLOAD_DIR, os.path.basename(url or ""))
    return os.path.getsize(p) if os.path.isfile(p) else None
async def kick(uid, sids=None):
    """Close live WebSockets of logged-out sessions (sids=None -> all of the user's connections)."""
    for ws in list(mgr.conns.get(uid, [])):
        if sids is None or getattr(ws.state, "sid", None) in sids:
            try: await ws.close(code=4401)
            except Exception: pass
def iso(d): return d.isoformat() + "Z" if d else None

# ---------- settings ----------
@router.get("/settings")
def settings_get(me=Depends(current_user), db=Depends(get_db)): return get_settings(db, me.id)

@router.patch("/settings")
def settings_patch(b: dict, me=Depends(current_user), db=Depends(get_db)):
    vals = b.get("values")
    if not isinstance(vals, dict) or not vals or len(vals) > 40: raise HTTPException(400, "Nothing to save")
    friends = set(friend_ids(db, me.id)); r = settings_row(db, me.id); d = load(r)
    for k, v in vals.items(): set_path(d, k.split("."), clean(k, v, friends))
    r.data = json.dumps(d); db.commit()
    return get_settings(db, me.id)

@router.post("/settings/reset-privacy")
def reset_privacy(me=Depends(current_user), db=Depends(get_db)):
    r = settings_row(db, me.id); d = load(r); d.pop("privacy", None); r.data = json.dumps(d); db.commit()
    return get_settings(db, me.id)

@router.get("/profile/preview")
def profile_preview(me=Depends(current_user), db=Depends(get_db)):
    s = get_settings(db, me.id)
    def view(contact):
        return dict(name=me.name, username=me.username, avatar=me.avatar if allowed(s, "photo", contact) else "", bio=(me.bio or "") if allowed(s, "about", contact) else "",
                    online=allowed(s, "online", contact), last_seen=allowed(s, "last_seen", contact))
    return {"contact": view(True), "everyone": view(False)}

# ---------- per-chat: archive, mute, clear, delete, export ----------
class PrefsIn(BaseModel): archived: bool | None = None; muted_until: str | None = None

@router.put("/chats/{cid}/prefs")
def chat_prefs(cid: int, b: PrefsIn, me=Depends(current_user), db=Depends(get_db)):
    member_of(db, me.id, cid); ch = {}
    if b.archived is not None: ch["archived"] = b.archived
    if b.muted_until is not None:
        if b.muted_until not in ("", "forever"):
            try: datetime.fromisoformat(b.muted_until.replace("Z", "+00:00"))
            except ValueError: raise HTTPException(400, "Invalid mute time")
        ch["muted_until"] = b.muted_until
    edit_prefs(db, me.id, cid, **ch); return {"ok": True}

def hide_history(db, me, cid, delete_chat):   # affects ONLY the current user; the friend keeps their copy
    mem = member_of(db, me.id, cid)
    last = db.query(func.max(Message.id)).filter_by(chat_id=cid).scalar() or 0
    mem.last_read_id = last
    edit_prefs(db, me.id, cid, cleared_before=last, **({"hidden": True} if delete_chat else {}))
    return {"ok": True}
@router.post("/chats/{cid}/clear")
def chat_clear(cid: int, me=Depends(current_user), db=Depends(get_db)): return hide_history(db, me, cid, False)
@router.post("/chats/{cid}/delete")
def chat_delete(cid: int, me=Depends(current_user), db=Depends(get_db)): return hide_history(db, me, cid, True)

def messages_export(db, me, only=None):
    prefs = get_settings(db, me.id)["chat_prefs"]; out = []
    for mem in db.query(Member).filter_by(user_id=me.id):
        if only and mem.chat_id != only: continue
        c = db.get(Chat, mem.chat_id); users = {m.user_id: db.get(User, m.user_id) for m in db.query(Member).filter_by(chat_id=c.id)}
        name = c.name if c.is_group else next((u.name for i, u in users.items() if i != me.id and u), "Deleted user")
        cleared = prefs.get(str(c.id), {}).get("cleared_before", 0)
        msgs = db.query(Message).filter(Message.chat_id == c.id, Message.id > cleared).order_by(Message.id).all()
        out.append(dict(chat=name, group=c.is_group, messages=[dict(time=iso(m.created), sender=(users.get(m.sender_id).name if users.get(m.sender_id) else "?"), type=m.kind, text=m.body, file=m.file_name) for m in msgs]))
    return out
def download(data, name): return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="{name}"'})

@router.get("/chats/export")
def chats_export(chat_id: int | None = None, me=Depends(current_user), db=Depends(get_db)):
    if chat_id: member_of(db, me.id, chat_id)
    return download({"exported": iso(datetime.utcnow()), "note": "Text backup; media files are not included", "chats": messages_export(db, me, chat_id)}, "friends-chat-backup.json")

# ---------- account ----------
class EmailIn(BaseModel): email: str; password: str
class PhoneIn(BaseModel): phone: str; password: str
class PassIn(BaseModel): current: str; new: str
class DeleteIn(BaseModel): password: str; confirm: str; code: str = ""
class CodeIn(BaseModel): code: str
class DisableIn(BaseModel): password: str; code: str

@router.get("/account")
def account(me=Depends(current_user), db=Depends(get_db)):
    st = db.get(UserSettings, me.id); week = datetime.utcnow() - timedelta(days=7)
    return dict(email=me.email, phone=me.phone, username=me.username, two_step=bool(st and st.totp_enabled), friends=len(friend_ids(db, me.id)),
                chats=db.query(Member).filter_by(user_id=me.id).count(), messages_sent=db.query(Message).filter_by(sender_id=me.id).count(),
                sessions=db.query(LoginSession).filter(LoginSession.user_id == me.id, LoginSession.revoked == False, LoginSession.created > week).count())

@router.put("/account/email")
async def change_email(b: EmailIn, me=Depends(current_user), db=Depends(get_db)):
    need_password(db, me, b.password); email = b.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email): raise HTTPException(400, "Enter a valid email")
    other = db.query(User).filter_by(email=email).first()
    if other and other.id != me.id: raise HTTPException(400, "Email already in use")
    me.email = email; db.commit(); await security_alert(db, me.id, "Your email address was changed"); return {"ok": True}

@router.put("/account/phone")
def change_phone(b: PhoneIn, me=Depends(current_user), db=Depends(get_db)):
    need_password(db, me, b.password)
    if not re.match(r"^\+?[0-9 \-]{7,20}$", b.phone.strip()): raise HTTPException(400, "Enter a valid phone number")
    me.phone = b.phone.strip(); db.commit(); return {"ok": True}

@router.post("/account/password")
async def change_password(b: PassIn, me=Depends(current_user), cur=Depends(current_session), db=Depends(get_db)):
    need_password(db, me, b.current)
    if len(b.new) < 8: raise HTTPException(400, "New password must be at least 8 characters")
    if b.new == b.current: raise HTTPException(400, "Choose a different password")
    me.password_hash = hash_pw(b.new)
    others = [s.id for s in db.query(LoginSession).filter(LoginSession.user_id == me.id, LoginSession.id != cur.id, LoginSession.revoked == False)]
    db.query(LoginSession).filter(LoginSession.user_id == me.id, LoginSession.id != cur.id).update({"revoked": True}); db.commit()
    await kick(me.id, set(others)); await security_alert(db, me.id, "Your password was changed; other devices were logged out"); return {"ok": True}

@router.get("/account/export")
def account_export(me=Depends(current_user), db=Depends(get_db)):
    calls = db.query(CallLog).filter(or_(CallLog.caller_id == me.id, CallLog.receiver_id == me.id)).all()
    return download({"exported": iso(datetime.utcnow()), "profile": dict(name=me.name, username=me.username, email=me.email, phone=me.phone, bio=me.bio, avatar=me.avatar),
        "settings": get_settings(db, me.id), "friends": [user_out(db.get(User, i), me.id) for i in friend_ids(db, me.id)],
        "blocked": [db.get(User, b.blocked_id).username for b in db.query(Block).filter_by(user_id=me.id)],
        "calls": [dict(type=c.call_type, status=c.status, started=iso(c.started), seconds=c.duration, outgoing=c.caller_id == me.id) for c in calls],
        "devices": [dict(device=s.device, ip=s.ip, created=iso(s.created), last_active=iso(s.last_active), revoked=s.revoked) for s in db.query(LoginSession).filter_by(user_id=me.id)],
        "chats": messages_export(db, me)}, "friends-chat-account.json")

@router.post("/account/delete")
async def account_delete(b: DeleteIn, me=Depends(current_user), db=Depends(get_db)):
    """Permanently removes the account, its messages, uploaded files, sessions, settings, call history and friendships."""
    if b.confirm.strip() != "DELETE": raise HTTPException(400, "Type DELETE to confirm")
    need_password(db, me, b.password)
    st = db.get(UserSettings, me.id)
    if st and st.totp_enabled and not verify_totp(st.totp_secret, b.code): raise HTTPException(403, "Wrong verification code")
    uid = me.id; notify = set(friend_ids(db, uid)); files = [me.avatar] if me.avatar else []
    if uid in in_call: await end_call(db, in_call[uid], "ended", by=uid)
    for mem in db.query(Member).filter_by(user_id=uid).all():
        c = db.get(Chat, mem.chat_id); rest = db.query(Member).filter(Member.chat_id == c.id, Member.user_id != uid).count()
        if not c.is_group or rest < 2:      # 1-to-1 chats (and groups left with fewer than 2 people) are removed completely
            files += [m.file_url for m in db.query(Message).filter_by(chat_id=c.id)]
            notify |= {o.user_id for o in db.query(Member).filter_by(chat_id=c.id)}
            db.query(Message).filter_by(chat_id=c.id).delete(); db.query(Member).filter_by(chat_id=c.id).delete(); db.delete(c)
        else:                               # bigger groups continue without this person's messages
            files += [m.file_url for m in db.query(Message).filter_by(chat_id=c.id, sender_id=uid)]
            db.query(Message).filter_by(chat_id=c.id, sender_id=uid).delete(); db.delete(mem)
    db.query(Message).filter_by(sender_id=uid).delete()
    db.query(Friendship).filter(or_(Friendship.from_id == uid, Friendship.to_id == uid)).delete(synchronize_session=False)
    db.query(Block).filter(or_(Block.user_id == uid, Block.blocked_id == uid)).delete(synchronize_session=False)
    db.query(CallLog).filter(or_(CallLog.caller_id == uid, CallLog.receiver_id == uid)).delete(synchronize_session=False)
    for model in (LoginSession, SupportReport, UserSettings): db.query(model).filter_by(user_id=uid).delete()
    db.delete(me); db.commit()
    for f in files: remove_file(f)
    await kick(uid); notify.discard(uid)
    for o in notify: await mgr.send(o, {"type": "account_removed"})
    return {"ok": True}

# ---------- security: two-step verification, sessions ----------
@router.get("/security/2fa")
def tfa_status(me=Depends(current_user), db=Depends(get_db)):
    st = db.get(UserSettings, me.id); return {"enabled": bool(st and st.totp_enabled)}

@router.post("/security/2fa/setup")
def tfa_setup(me=Depends(current_user), db=Depends(get_db)):
    r = settings_row(db, me.id)
    if r.totp_enabled: raise HTTPException(400, "Already enabled")
    r.totp_secret = new_totp_secret(); db.commit()
    return {"secret": r.totp_secret, "uri": f"otpauth://totp/FriendsChat:{quote(me.email)}?secret={r.totp_secret}&issuer=FriendsChat"}

@router.post("/security/2fa/enable")
async def tfa_enable(b: CodeIn, me=Depends(current_user), db=Depends(get_db)):
    r = settings_row(db, me.id); key = f"2fa|{me.id}"; check_throttle(key)
    if not r.totp_secret or not verify_totp(r.totp_secret, b.code): add_fail(key); raise HTTPException(400, "That code is not correct. Check the time on your phone and try again.")
    r.totp_enabled = True; db.commit(); await security_alert(db, me.id, "Two-step verification was turned on"); return {"ok": True}

@router.post("/security/2fa/disable")
async def tfa_disable(b: DisableIn, me=Depends(current_user), db=Depends(get_db)):
    need_password(db, me, b.password); r = settings_row(db, me.id)
    if not r.totp_enabled: raise HTTPException(400, "Two-step verification is off")
    if not verify_totp(r.totp_secret, b.code): raise HTTPException(403, "Wrong verification code")
    r.totp_enabled = False; r.totp_secret = ""; db.commit(); await security_alert(db, me.id, "Two-step verification was turned off"); return {"ok": True}

@router.get("/sessions")
def sessions(me=Depends(current_user), cur=Depends(current_session), db=Depends(get_db)):
    week = datetime.utcnow() - timedelta(days=7)   # login tokens last 7 days
    rows = db.query(LoginSession).filter(LoginSession.user_id == me.id, LoginSession.revoked == False, LoginSession.created > week).order_by(LoginSession.last_active.desc()).all()
    return [dict(id=s.id, device=s.device, ip=s.ip, created=iso(s.created), last_active=iso(s.last_active), current=s.id == cur.id) for s in rows]

@router.delete("/sessions/{sid}")
async def revoke_session(sid: str, me=Depends(current_user), db=Depends(get_db)):
    s = db.get(LoginSession, sid)
    if not s or s.user_id != me.id: raise HTTPException(404, "Device not found")
    s.revoked = True; db.commit(); await kick(me.id, {sid}); return {"ok": True}

@router.post("/sessions/revoke-others")
async def revoke_others(me=Depends(current_user), cur=Depends(current_session), db=Depends(get_db)):
    rows = db.query(LoginSession).filter(LoginSession.user_id == me.id, LoginSession.id != cur.id, LoginSession.revoked == False).all(); ids = {s.id for s in rows}
    for s in rows: s.revoked = True
    db.commit(); await kick(me.id, ids); return {"logged_out": len(ids)}

@router.post("/logout")
def logout(cur=Depends(current_session), db=Depends(get_db)):
    cur.revoked = True; db.commit(); return {"ok": True}

# ---------- storage & media ----------
@router.get("/storage")
def storage(me=Depends(current_user), db=Depends(get_db)):
    cids = [m.chat_id for m in db.query(Member).filter_by(user_id=me.id)]
    rows = db.query(Message).filter(Message.chat_id.in_(cids), Message.file_url != "", Message.kind != "text").order_by(Message.id.desc()).all() if cids else []
    cats = {k: {"count": 0, "bytes": 0} for k in ("image", "video", "audio", "file")}; files = []; missing = sent = recv = 0
    for m in rows:
        size = file_size(m.file_url)
        if size is None: missing += 1
        elif m.kind in cats:
            cats[m.kind]["count"] += 1; cats[m.kind]["bytes"] += size
            if m.sender_id == me.id: sent += size
            else: recv += size
        if len(files) < 100: files.append(dict(id=m.id, chat_id=m.chat_id, kind=m.kind, name=m.file_name, size=size or 0, missing=size is None, mine=m.sender_id == me.id, created=iso(m.created)))
    return dict(total_bytes=sent + recv, sent_bytes=sent, received_bytes=recv, missing=missing, categories=cats, files=files)

def wipe(db, ms):
    by_chat = {}
    for m in ms:
        remove_file(m.file_url); m.kind, m.body, m.file_url, m.file_name = "text", "🗑️ Media deleted", "", ""; by_chat.setdefault(m.chat_id, []).append(m.id)
    db.commit(); return by_chat
async def announce(db, by_chat):
    for cid, ids in by_chat.items():
        for mem in db.query(Member).filter_by(chat_id=cid): await mgr.send(mem.user_id, {"type": "media_deleted", "chat_id": cid, "ids": ids})

@router.delete("/media/{mid}")
async def delete_media(mid: int, me=Depends(current_user), db=Depends(get_db)):
    m = db.get(Message, mid)
    if not m or m.sender_id != me.id or m.kind == "text": raise HTTPException(404, "You can only delete media you sent")
    await announce(db, wipe(db, [m])); return {"ok": True}

class CleanupIn(BaseModel): kind: str = "all"; older_than_days: int = 0
@router.post("/media/cleanup")
async def cleanup_media(b: CleanupIn, me=Depends(current_user), db=Depends(get_db)):
    q = db.query(Message).filter(Message.sender_id == me.id, Message.file_url != "", Message.kind != "text")
    if b.kind != "all":
        if b.kind not in ("image", "video", "audio", "file"): raise HTTPException(400, "Invalid type")
        q = q.filter(Message.kind == b.kind)
    if b.older_than_days > 0: q = q.filter(Message.created < datetime.utcnow() - timedelta(days=min(b.older_than_days, 3650)))
    ms = q.all(); freed = sum(file_size(m.file_url) or 0 for m in ms)
    await announce(db, wipe(db, ms)); return {"deleted": len(ms), "freed_bytes": freed}

# ---------- help & support ----------
class SupportIn(BaseModel): kind: str; message: str
@router.post("/support")
def support(b: SupportIn, request: Request, me=Depends(current_user), db=Depends(get_db)):
    msg = b.message.strip(); key = f"support|{me.id}"; check_throttle(key, 5, 3600)
    if b.kind not in ("support", "problem") or not 10 <= len(msg) <= 2000: raise HTTPException(400, "Please write between 10 and 2000 characters")
    add_fail(key); db.add(SupportReport(user_id=me.id, kind=b.kind, message=msg, user_agent=request.headers.get("user-agent", "")[:200])); db.commit()
    return {"ok": True}

@router.get("/app-info")
def app_info(): return dict(name="Friends Chat", version=os.getenv("APP_VERSION", "1.4.0"), support_email=os.getenv("SUPPORT_EMAIL", ""),
                group_calls=all(os.getenv(k) for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")))
