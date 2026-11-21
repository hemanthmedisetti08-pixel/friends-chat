"""Group management (info, settings, members, admins, exit, delete), user profiles and GROUP CALLS.
Group calls use an SFU media server (LiveKit): browsers send/receive media through LiveKit, while this server only
(1) signals who is calling over the existing WebSocket and (2) hands out short-lived LiveKit join tokens to group members."""
import os, json, time
from datetime import datetime
import jwt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from main import (get_db, current_user, User, Chat, Member, Message, GroupInfo, Block, user_out, msg_out, mgr, friend_ids, find_friendship, relation, is_blocked)
from settings_api import remove_file

router = APIRouter(prefix="/api")
gcalls = {}   # chat_id -> {room, type, started, starter, joined:set(user ids)}

# ---------- helpers ----------
def member_ids(db, cid): return [m.user_id for m in db.query(Member).filter_by(chat_id=cid).order_by(Member.id)]
def info_for(db, chat):
    gi = db.get(GroupInfo, chat.id)
    if not gi:   # group made before this update: the earliest member becomes the owner
        ids = member_ids(db, chat.id); gi = GroupInfo(chat_id=chat.id, owner_id=ids[0] if ids else None, admins=json.dumps(ids[:1])); db.add(gi); db.commit()
    return gi
def admins_of(gi): return set(json.loads(gi.admins or "[]")) | {gi.owner_id}
def ctx(db, me, cid):
    """Returns (chat, info, admin_ids) or 404 - also for deleted groups and for people who left / were removed."""
    chat = db.get(Chat, cid); mem = db.query(Member).filter_by(chat_id=cid, user_id=me.id).first() if chat else None
    if not chat or not chat.is_group or not mem: raise HTTPException(404, "Group not found")
    gi = info_for(db, chat); return chat, gi, admins_of(gi)
def names(db, ids): return ", ".join((db.get(User, i).name if db.get(User, i) else "?") for i in ids)
async def push(ids, ev, cid, **extra):
    for u in ids: await mgr.send(u, dict(type=ev, chat_id=cid, **extra))
async def sysmsg(db, cid, sender, text, ids=None):
    m = Message(chat_id=cid, sender_id=sender, kind="system", body=text, status="read"); db.add(m); db.commit()
    for u in (ids if ids is not None else member_ids(db, cid)): await mgr.send(u, {"type": "message", "message": msg_out(m)})
def calls_enabled(): return all(os.getenv(k) for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"))
def state_payload(db, cid):
    c = gcalls.get(cid)
    return dict(type="gcall_state", chat_id=cid, active=bool(c), call_type=c["type"] if c else None, started=c["started"] if c else None,
                participants=[dict(id=u, name=(db.get(User, u).name if db.get(User, u) else "?")) for u in (c["joined"] if c else [])])

def group_out(db, me, chat, gi, admins):
    mine = me.id in admins
    members = []
    for uid in member_ids(db, chat.id):
        u = db.get(User, uid)
        members.append(dict(user=user_out(u, me.id), role="owner" if uid == gi.owner_id else "admin" if uid in admins else "member"))
    owner = db.get(User, gi.owner_id)
    return dict(id=chat.id, name=chat.name, description=gi.description or "", avatar=gi.avatar or "", created=gi.created.isoformat() + "Z" if gi.created else None,
                owner=dict(id=gi.owner_id, name=owner.name if owner else "Unknown"), members=members,
                my_role="owner" if me.id == gi.owner_id else "admin" if mine else "member",
                permissions=dict(edit_info=gi.edit_info, add_members=gi.add_members),
                can_edit=mine or gi.edit_info == "all", can_add=mine or gi.add_members == "all", can_manage=mine, can_delete=mine,
                delete_reason="" if mine else "Only group admins can delete the group.", calls_enabled=calls_enabled(), call=state_payload(db, chat.id))

# ---------- user profile (for the profile page) ----------
@router.get("/users/{uid}")
def user_detail(uid: int, me=Depends(current_user), db=Depends(get_db)):
    u = db.get(User, uid)
    if not u: raise HTTPException(404, "User not found")
    mine = [m.chat_id for m in db.query(Member).filter_by(user_id=me.id)]
    shared = uid == me.id or db.query(Member).filter(Member.user_id == uid, Member.chat_id.in_(mine)).first() if mine else uid == me.id
    if not find_friendship(db, me.id, uid) and not shared: raise HTTPException(404, "User not found")   # no looking up strangers
    dm = next((c.id for c in (db.get(Chat, i) for i in mine) if not c.is_group and db.query(Member).filter_by(chat_id=c.id, user_id=uid).first()), None)
    return dict(user_out(u, me.id), relation="self" if uid == me.id else relation(db, me.id, uid),
                blocked_by_me=bool(db.query(Block).filter_by(user_id=me.id, blocked_id=uid).first()), chat_id=dm)

# ---------- group info & settings ----------
@router.get("/groups/{cid}")
def group_get(cid: int, me=Depends(current_user), db=Depends(get_db)):
    chat, gi, admins = ctx(db, me, cid); return group_out(db, me, chat, gi, admins)

class GroupEdit(BaseModel): name: str | None = None; description: str | None = None; avatar: str | None = None
@router.put("/groups/{cid}")
async def group_edit(cid: int, b: GroupEdit, me=Depends(current_user), db=Depends(get_db)):
    chat, gi, admins = ctx(db, me, cid)
    if not (me.id in admins or gi.edit_info == "all"): raise HTTPException(403, "Only group admins can edit the group")
    notes = []
    if b.name is not None:
        n = b.name.strip()
        if not 1 <= len(n) <= 80: raise HTTPException(400, "Group name must be 1-80 characters")
        if n != chat.name: chat.name = n; notes.append(f'{me.name} changed the group name to "{n}"')
    if b.description is not None:
        if len(b.description) > 300: raise HTTPException(400, "Description is too long (max 300)")
        if b.description.strip() != (gi.description or ""): gi.description = b.description.strip(); notes.append(f"{me.name} changed the group description")
    if b.avatar is not None:
        if b.avatar and not (b.avatar.startswith("/uploads/") and len(b.avatar) < 200): raise HTTPException(400, "Invalid picture")
        if b.avatar != (gi.avatar or ""): gi.avatar = b.avatar; notes.append(f"{me.name} changed the group icon")
    db.commit()
    for t in notes: await sysmsg(db, cid, me.id, t)
    await push(member_ids(db, cid), "group_updated", cid); return group_out(db, me, chat, gi, admins)

class PermIn(BaseModel): edit_info: str | None = None; add_members: str | None = None
@router.put("/groups/{cid}/permissions")
async def group_permissions(cid: int, b: PermIn, me=Depends(current_user), db=Depends(get_db)):
    chat, gi, admins = ctx(db, me, cid)
    if me.id not in admins: raise HTTPException(403, "Only group admins can change these rules")
    for field in ("edit_info", "add_members"):
        v = getattr(b, field)
        if v is not None:
            if v not in ("admins", "all"): raise HTTPException(400, "Invalid value")
            setattr(gi, field, v)
    db.commit(); await push(member_ids(db, cid), "group_updated", cid); return {"ok": True}

# ---------- members & admins ----------
class AddIn(BaseModel): user_ids: list[int]
@router.post("/groups/{cid}/members")
async def group_add(cid: int, b: AddIn, me=Depends(current_user), db=Depends(get_db)):
    chat, gi, admins = ctx(db, me, cid)
    if not (me.id in admins or gi.add_members == "all"): raise HTTPException(403, "Only group admins can add members")
    have = set(member_ids(db, cid)); mine = set(friend_ids(db, me.id))
    new = [i for i in dict.fromkeys(b.user_ids) if i in mine and i not in have and not is_blocked(db, me.id, i)]    # only your own friends
    if not new: raise HTTPException(400, "Pick friends who are not in the group yet")
    if len(have) + len(new) > 100: raise HTTPException(400, "A group can have at most 100 members")
    db.add_all([Member(chat_id=cid, user_id=i) for i in new]); db.commit()
    await sysmsg(db, cid, me.id, f"{me.name} added {names(db, new)}")
    await push(new, "chat_created", cid); await push(list(have), "group_updated", cid); return {"added": len(new)}

@router.delete("/groups/{cid}/members/{uid}")
async def group_remove(cid: int, uid: int, me=Depends(current_user), db=Depends(get_db)):
    chat, gi, admins = ctx(db, me, cid)
    if me.id not in admins: raise HTTPException(403, "Only group admins can remove members")
    if uid == me.id: raise HTTPException(400, "Use Exit group to leave")
    if uid == gi.owner_id: raise HTTPException(403, "The group owner cannot be removed")
    if uid in admins and me.id != gi.owner_id: raise HTTPException(403, "Only the owner can remove an admin")
    mem = db.query(Member).filter_by(chat_id=cid, user_id=uid).first()
    if not mem: raise HTTPException(404, "Not a member")
    await leave_call(db, cid, uid)
    gi.admins = json.dumps([a for a in json.loads(gi.admins or "[]") if a != uid]); db.delete(mem); db.commit()
    await sysmsg(db, cid, me.id, f"{me.name} removed {names(db, [uid])}")
    await push([uid], "group_removed", cid, reason="removed"); await push(member_ids(db, cid), "group_updated", cid); return {"ok": True}

class AdminIn(BaseModel): user_id: int; admin: bool
@router.post("/groups/{cid}/admins")
async def group_admin(cid: int, b: AdminIn, me=Depends(current_user), db=Depends(get_db)):
    chat, gi, admins = ctx(db, me, cid)
    if me.id not in admins: raise HTTPException(403, "Only group admins can manage admins")
    if not db.query(Member).filter_by(chat_id=cid, user_id=b.user_id).first(): raise HTTPException(404, "Not a member")
    if b.user_id == gi.owner_id: raise HTTPException(403, "The owner is always an admin")
    cur = json.loads(gi.admins or "[]")
    if b.admin and b.user_id not in cur: cur.append(b.user_id)
    elif not b.admin:
        if me.id != gi.owner_id: raise HTTPException(403, "Only the owner can remove an admin")
        cur = [a for a in cur if a != b.user_id]
    gi.admins = json.dumps(cur); db.commit()
    await sysmsg(db, cid, me.id, f"{me.name} {'made' if b.admin else 'removed'} {names(db, [b.user_id])} {'an admin' if b.admin else 'as admin'}")
    await push(member_ids(db, cid), "group_updated", cid); return {"ok": True}

# ---------- exit & delete ----------
async def purge_group(db, chat, reason="deleted"):
    cid = chat.id; ids = member_ids(db, cid); gi = db.get(GroupInfo, cid)
    files = [m.file_url for m in db.query(Message).filter_by(chat_id=cid)] + ([gi.avatar] if gi and gi.avatar else [])
    db.query(Message).filter_by(chat_id=cid).delete(); db.query(Member).filter_by(chat_id=cid).delete()
    if gi: db.delete(gi)
    db.delete(chat); db.commit()
    for f in files: remove_file(f)
    gcalls.pop(cid, None); await push(ids, "group_removed", cid, reason=reason)

@router.post("/groups/{cid}/leave")
async def group_leave(cid: int, me=Depends(current_user), db=Depends(get_db)):
    """Exit group = only ME leave. The group continues for everyone else."""
    chat, gi, admins = ctx(db, me, cid)
    await leave_call(db, cid, me.id)
    db.query(Member).filter_by(chat_id=cid, user_id=me.id).delete(); db.commit()
    rest = member_ids(db, cid)
    if not rest: await purge_group(db, chat, "left"); return {"ok": True}
    cur = [a for a in json.loads(gi.admins or "[]") if a != me.id]; extra = None
    if gi.owner_id == me.id:           # owner leaves: next admin (else oldest member) becomes owner
        gi.owner_id = next((a for a in cur if a in rest), rest[0]); extra = f"{names(db, [gi.owner_id])} is now the group owner"
        if gi.owner_id not in cur: cur.append(gi.owner_id)
    gi.admins = json.dumps(cur); db.commit()
    await sysmsg(db, cid, me.id, f"{me.name} left", rest)
    if extra: await sysmsg(db, cid, gi.owner_id, extra, rest)
    await push([me.id], "group_removed", cid, reason="left"); await push(rest, "group_updated", cid); return {"ok": True}

@router.delete("/groups/{cid}")
async def group_delete(cid: int, me=Depends(current_user), db=Depends(get_db)):
    """Delete group = removed for EVERY member (messages and files are erased). Admins/owner only."""
    chat, gi, admins = ctx(db, me, cid)
    if me.id not in admins: raise HTTPException(403, "Only group admins can delete the group")
    await purge_group(db, chat, "deleted"); return {"ok": True}

# ---------- group calls (signaling over the existing WebSocket; media through LiveKit) ----------
def livekit_token(uid, name, room):
    now = int(time.time())
    return jwt.encode({"iss": os.getenv("LIVEKIT_API_KEY"), "sub": str(uid), "name": name, "nbf": now - 10, "exp": now + 7200,
                       "video": {"room": room, "roomJoin": True, "canPublish": True, "canSubscribe": True, "canPublishData": True}},
                      os.getenv("LIVEKIT_API_SECRET"), algorithm="HS256")

async def broadcast_state(db, cid):
    for u in member_ids(db, cid): await mgr.send(u, state_payload(db, cid))

async def leave_call(db, cid, uid):
    c = gcalls.get(cid)
    if not c or uid not in c["joined"]: return
    c["joined"].discard(uid)
    if c["joined"]:
        await broadcast_state(db, cid); return
    gcalls.pop(cid, None); secs = int(time.time() - c["started"])
    await broadcast_state(db, cid)
    await sysmsg(db, cid, uid, f"Group {'video' if c['type'] == 'video' else 'voice'} call ended · {secs // 60:02d}:{secs % 60:02d}")

async def gcall_drop(db, uid):
    for cid in list(gcalls): await leave_call(db, cid, uid)

async def gcall_sync(db, uid):
    for cid in list(gcalls):
        if db.query(Member).filter_by(chat_id=cid, user_id=uid).first(): await mgr.send(uid, state_payload(db, cid))

async def handle_gcall(db, uid, data):
    t, cid = data.get("type"), data.get("chat_id")
    chat = db.get(Chat, cid) if isinstance(cid, int) else None
    if not chat or not chat.is_group or not db.query(Member).filter_by(chat_id=cid, user_id=uid).first(): return   # members only
    if t == "gcall_leave": return await leave_call(db, cid, uid)
    if t not in ("gcall_start", "gcall_join"): return
    if not calls_enabled():
        return await mgr.send(uid, {"type": "gcall_error", "chat_id": cid, "detail": "Group calls are not set up on this server yet. The site owner must connect a LiveKit media server."})
    user = db.get(User, uid); c = gcalls.get(cid)
    if not c:
        if t == "gcall_join": return await mgr.send(uid, {"type": "gcall_error", "chat_id": cid, "detail": "This call has already ended"})
        ctype = "video" if data.get("call_type") == "video" else "audio"
        c = gcalls[cid] = dict(room=f"g{cid}-{int(time.time())}", type=ctype, started=time.time(), starter=uid, joined=set())
        await sysmsg(db, cid, uid, f"{user.name} started a group {'video' if ctype == 'video' else 'voice'} call")
        for m in member_ids(db, cid):
            if m != uid: await mgr.send(m, {"type": "gcall_ring", "chat_id": cid, "call_type": ctype, "user": user_out(user, m), "group": chat.name})
    c["joined"].add(uid)
    await mgr.send(uid, {"type": "gcall_token", "chat_id": cid, "call_type": c["type"], "room": c["room"], "url": os.getenv("LIVEKIT_URL"), "token": livekit_token(uid, user.name, c["room"])})
    await broadcast_state(db, cid)
