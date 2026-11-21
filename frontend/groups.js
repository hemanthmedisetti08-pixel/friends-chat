/* ===== Block / unblock, contact profile page, group info and management ===== */
let blockedIds=new Set(),G=null,profileName='';
async function loadBlocked(){try{blockedIds=new Set((await api('/blocked')).map(u=>u.id))}catch(e){}}

/* ---- block / unblock ---- */
function renderBlockBar(c){
  const bar=$('#blockBar'),f=document.querySelector('#pane footer'),mine=!!(c&&!c.is_group&&c.blocked_by_me);
  bar.hidden=!mine;f.hidden=mine;
  if(mine)bar.innerHTML=`🚫 You blocked <b>${esc(c.name)}</b>. <button class="callbtn green" onclick="toggleBlock(${c.other.id})">Unblock</button>`;
}
function toggleBlock(id,nm){
  const u=chats.map(c=>c.other).concat(friends).find(x=>x&&x.id===id),name=nm||(u&&u.name)||(routeNow()==='/profile/'+id?profileName:'')||'this contact',b=blockedIds.has(id);
  confirmDlg(b?`Unblock ${esc(name)}?`:`Block ${esc(name)}?`,b?'They will be able to message and call you again (if you are still friends).':'Blocked contacts cannot message or call you and cannot see your photo, about or online status. Your chat history is kept.',b?'Unblock':'Block',
    async()=>{await api(b?'/unblock':'/block','POST',{user_id:id});await Promise.all([loadBlocked(),loadChats(),loadFriends()]);toast(b?name+' unblocked':name+' blocked');refreshViews()},!b);
}
function refreshViews(){
  if(active&&cur())renderHead();renderList();
  const s=document.getElementById('settings');if(s&&!s.hidden&&nav.split(':')[0]==='privacy')renderSection(true);
  const p=routeNow().split('/');if(p[1]==='profile')showProfile(+p[2]);if(p[1]==='group')showGroup(+p[2],p[3]);
}
const blockOp=(op,id)=>toggleBlock(id);   // used by Settings > Privacy

/* ---- full-screen page used for profiles and groups ---- */
function pageEl(){
  let el=$('#gpage');
  if(!el){el=document.createElement('div');el.id='gpage';el.className='spage gpage open';el.hidden=true;el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');
    el.innerHTML=`<section class="smain"><header><button class="icon" aria-label="Back" onclick="navBack()">←</button><h3 id="gTitleP"></h3></header><div id="gBody" tabindex="-1"></div></section>`;document.body.append(el)}
  return el;
}
const hidePage=()=>{const e=$('#gpage');if(e)e.hidden=true};
function openPage(title){pageEl().hidden=false;$('#gTitleP').textContent=title;$('#gBody').innerHTML='<div class="spin" role="status" aria-label="Loading"></div>'}
const dis=(ic,l,d)=>`<div class="srow dis" aria-disabled="true"><span class="ic">${ic}</span><div class="grow"><b>${l}</b><small>${d}</small></div></div>`;
const seen=u=>u.online?'Online':u.last_seen?'Last seen '+new Date(u.last_seen).toLocaleString([],{dateStyle:'short',timeStyle:'short'}):'';

/* ---- contact profile ---- */
async function showProfile(uid){
  openPage('Contact info');
  try{
    const u=await api('/users/'+uid);if(routeNow()!=='/profile/'+uid)return;
    profileName=u.name;const fr=u.relation==='friend',self=u.relation==='self',dm=u.chat_id;
    let a='';
    if(self)a=act('⚙️','This is you','Edit your profile in Settings',"navPush('/settings/profile')");
    else{
      if(fr&&dm&&!u.blocked_by_me)a+=act('💬','Message','Open the chat',`goChat(${dm})`)+act('📞','Voice call','',`profileCall(${dm},'audio')`)+act('🎥','Video call','',`profileCall(${dm},'video')`);
      if(fr&&dm&&u.blocked_by_me)a+=act('💬','Open chat','History is kept',`goChat(${dm})`);
      if(u.relation==='none'&&!u.blocked_by_me)a+=act('➕','Send friend request','',`reqFriend(${uid})`);
      if(u.relation==='sent')a+=dis('⏳','Friend request sent','Waiting for them to accept');
      if(u.relation==='received')a+=dis('📩','They sent you a friend request','Answer it in the Friends tab');
      a+=act(u.blocked_by_me?'✅':'🚫',u.blocked_by_me?'Unblock':'Block',u.blocked_by_me?'Allow messages and calls again':'Stop messages and calls from this contact',`toggleBlock(${uid})`,!u.blocked_by_me);
    }
    $('#gBody').innerHTML=`<div class="pcard">${av(u.name,u.avatar,u.online)}<h2>${esc(u.name)}</h2><small>@${esc(u.username)}</small><p>${esc(u.bio)||'<i>No about info</i>'}</p><small>${seen(u)}</small>${u.blocked_by_me?'<span class="badge mut">Blocked</span>':''}</div>`+grp('',a);
  }catch(e){toast(e.message);navReplace('/')}
}
const profileCall=(chatId,type)=>{goChat(chatId);setTimeout(()=>startCall(type),300)};
const reqFriend=id=>api('/friends/request','POST',{user_id:id}).then(()=>{toast('Friend request sent');showProfile(id)}).catch(e=>toast(e.message));
function headClick(){const c=cur();if(!c)return;navPush(c.is_group?'/group/'+c.id:'/profile/'+c.other.id)}

/* ---- group info ---- */
async function showGroup(cid,sub){
  openPage(sub==='add'?'Add members':'Group info');
  try{
    G=await api('/groups/'+cid);if(!routeNow().startsWith('/group/'+cid))return;
    sub==='add'?renderAdd():renderGroup();
  }catch(e){toast(e.message);hidePage();navReplace('/')}
}
function renderGroup(){
  const g=G,me_=g.my_role,d=g.created?new Date(g.created).toLocaleDateString([],{dateStyle:'long'}):'unknown date',cs=g.call,ce=g.calls_enabled;
  const sel=(f,v)=>`<select ${g.can_manage?'':'disabled'} aria-label="${f}" onchange="setPerm('${f}',this.value)"><option value="admins" ${v==='admins'?'selected':''}>Admins only</option><option value="all" ${v==='all'?'selected':''}>All members</option></select>`;
  const callRow=(ic,l,t)=>ce?act(ic,l,cs.active?`${cs.participants.length} in the call · tap to join`:'Call everyone in the group',`startGroupCallFromInfo('${t}')`):dis(ic,l,'Needs a LiveKit media server (not set up yet)');
  $('#gBody').innerHTML=`<div class="pcard">${av(g.name,g.avatar)}<h2>${esc(g.name)}</h2><p>${esc(g.description)||'<i>No description</i>'}</p><small>Created ${d} · by ${esc(g.owner.name)}</small>`
  +(g.can_edit?`<div class="actions"><label class="no btnlike" tabindex="0">Change photo<input type="file" accept="image/*" hidden onchange="gPhoto(this)"></label><button class="no" onclick="gEditDlg()">Edit name & description</button></div>`:'<small>Only admins can edit this group</small>')+'</div>'
  +grp('Group calls',callRow('📞','Group voice call','audio')+callRow('🎥','Group video call','video'))
  +grp('Members ('+g.members.length+')',g.members.map(m=>{const u=m.user,mine=u.id===me.id,own=me_==='owner';
    const btns=g.can_manage&&!mine&&m.role!=='owner'?`<span class="mact">${m.role==='member'?`<button class="no" onclick="event.stopPropagation();gAdmin(${u.id},true)">Make admin</button>`:own?`<button class="no" onclick="event.stopPropagation();gAdmin(${u.id},false)">Remove admin</button>`:''}${(m.role==='member'||own)?`<button class="no" onclick="event.stopPropagation();gRemove(${u.id})">Remove</button>`:''}</span>`:'';
    return `<div class="srow act" tabindex="0" role="button" onclick="navPush('/profile/${u.id}')" onkeydown="if(event.key==='Enter')this.click()">${av(u.name,u.avatar,u.online)}<div class="grow"><b>${esc(u.name)}${mine?' (You)':''}</b><small>${esc(u.bio)||'@'+esc(u.username)}</small></div>${m.role!=='member'?`<span class="badge">${m.role==='owner'?'Owner':'Admin'}</span>`:''}${btns}</div>`}).join(''))
  +grp('Group settings',`<div class="srow"><div class="grow"><b>Who can edit group info</b><small>Name, photo and description</small></div>${sel('edit_info',g.permissions.edit_info)}</div><div class="srow"><div class="grow"><b>Who can add members</b><small>Only your own friends can be added</small></div>${sel('add_members',g.permissions.add_members)}</div>${g.can_manage?'':'<div class="note">Only admins can change these rules.</div>'}`)
  +grp('',(g.can_add?act('➕','Add members','Invite your friends',`navPush('/group/${g.id}/add')`):dis('➕','Add members','Only admins can add members'))
    +act('🚪','Exit group','You stop receiving messages; the group stays for others','exitGroup()',true)
    +(g.can_delete?act('🗑️','Delete group','Removes the group and its messages for everyone','delGroup()',true):dis('🗑️','Delete group',esc(g.delete_reason))));
}
function renderAdd(){
  const have=new Set(G.members.map(m=>m.user.id)),list=friends.filter(f=>!have.has(f.id)&&!blockedIds.has(f.id));
  $('#gBody').innerHTML=(G.can_add?'':note('Only admins can add members.'))+grp('Your friends',list.map(f=>`<label class="srow chk">${av(f.name,f.avatar)}<span class="grow"><b>${esc(f.name)}</b></span><input type="checkbox" class="am" value="${f.id}"></label>`).join('')||'<div class="srow"><small>All your friends are already in this group</small></div>')+(list.length&&G.can_add?`<div class="actions pact"><button onclick="navBack()">Cancel</button><button class="primary" onclick="gAddSel()">Add selected</button></div>`:'');
}
const refreshGroup=()=>{const p=routeNow().split('/');if(p[1]==='group')showGroup(+p[2],p[3])};
const gErr=e=>toast(e.message);
function gEditDlg(){formDlg('Edit group',[{n:'name',l:'Group name',v:G.name},{n:'description',l:'Description',type:'textarea',v:G.description}],'Save',v=>api('/groups/'+G.id,'PUT',v).then(()=>{toast('Group updated');refreshGroup()}))}
async function gPhoto(i){if(!i.files[0])return;try{const d=await upload(i.files[0]);await api('/groups/'+G.id,'PUT',{avatar:d.url});toast('Group photo updated');refreshGroup()}catch(e){gErr(e)}}
const setPerm=(f,v)=>api(`/groups/${G.id}/permissions`,'PUT',{[f]:v}).then(()=>toast('Saved')).catch(e=>{gErr(e);refreshGroup()});
const gAdmin=(uid,on)=>api(`/groups/${G.id}/admins`,'POST',{user_id:uid,admin:on}).then(()=>{toast(on?'Made admin':'Admin removed');refreshGroup()}).catch(gErr);
const gRemove=uid=>{const m=G.members.find(m=>m.user.id===uid);confirmDlg(`Remove ${esc(m.user.name)}?`,'They will no longer receive messages from this group.','Remove',()=>api(`/groups/${G.id}/members/${uid}`,'DELETE').then(()=>{toast('Member removed');refreshGroup()}))};
const gAddSel=()=>{const ids=[...document.querySelectorAll('.am:checked')].map(x=>+x.value);if(!ids.length)return toast('Pick at least one friend');api(`/groups/${G.id}/members`,'POST',{user_ids:ids}).then(r=>{toast(r.added+' member(s) added');navBack()}).catch(gErr)};
const leaveDone=async()=>{await loadChats();hidePage();hidePane();navReplace('/')};
const exitGroup=(id)=>{const gid=id||G.id;confirmDlg('Exit group?','You will stop sending and receiving messages in this group. It stays available to the other members.','Exit group',async()=>{await api(`/groups/${gid}/leave`,'POST');toast('You left the group');await leaveDone()})};
const delGroup=()=>confirmDlg(`Delete “${esc(G.name)}”?`,'This removes the group, all messages and files for EVERY member. It cannot be undone.','Delete group',async()=>{await api('/groups/'+G.id,'DELETE');toast('Group deleted');await leaveDone()});
const startGroupCallFromInfo=t=>{goChat(G.id);setTimeout(()=>startGroupCall(t),300)};

/* ---- live group events from the server ---- */
function handleGroupEvent(d){
  if(d.type==='group_updated'){
    loadChats().then(()=>{if(active&&cur())renderHead()});
    const p=routeNow().split('/');if(p[1]==='group'&&+p[2]===d.chat_id)showGroup(d.chat_id,p[3]);return true;
  }
  if(d.type==='group_removed'){
    const m={removed:'You were removed from a group',deleted:'A group was deleted by an admin'}[d.reason];if(m)toast(m);
    if(typeof GC!=='undefined'&&GC.chat===d.chat_id)leaveGroupCall();
    delete msgs[d.chat_id];const re=new RegExp('^/(chat|group)/'+d.chat_id+'(/|$)');
    loadChats().then(()=>{if(active===d.chat_id)hidePane();if(re.test(routeNow())){hidePage();navReplace('/')}});return true;
  }
  return false;
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#modal').hidden){const p=$('#gpage');if(p&&!p.hidden)navBack()}});
