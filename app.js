const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=iso=>new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
let token=localStorage.token,me,chats=[],friends=[],requests=[],results=[],tab='chats',active=null,msgs={},ws,rec,timer;
if(localStorage.dark)document.body.classList.add('dark');

async function api(p,m='GET',b){
  const r=await fetch('/api'+p,{method:m,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){if(r.status===401&&token)logout();throw new Error(typeof d.detail==='string'?d.detail:'Please check your input')}
  return d;
}
function toast(t){const e=document.createElement('div');e.className='toast';e.textContent=t;document.body.append(e);setTimeout(()=>e.remove(),3000)}
const av=(name,img,on)=>`<div class="av">${img?`<img src="${esc(img)}">`:esc((name||'?')[0].toUpperCase())}${on?'<i class="dot"></i>':''}</div>`;
const preview=m=>m.kind==='text'?m.body:{image:'📷 Photo',video:'🎬 Video',audio:'🎤 Voice message',file:'📄 Document'}[m.kind];
const cur=()=>chats.find(c=>c.id===active);

// ---------- Auth ----------
function setAuth(m){$('#loginForm').hidden=m!=='login';$('#regForm').hidden=m!=='reg';$('#tabLogin').classList.toggle('on',m==='login');$('#tabReg').classList.toggle('on',m==='reg')}
async function submitAuth(e,mode){e.preventDefault();try{const d=await api(mode==='login'?'/login':'/register','POST',Object.fromEntries(new FormData(e.target)));token=d.token;localStorage.token=token;start()}catch(x){toast(x.message)}}
function logout(){localStorage.removeItem('token');token=null;ws&&ws.close();location.reload()}
async function start(){
  try{me=await api('/me')}catch{return}
  $('#auth').hidden=true;$('#app').hidden=false;renderMe();
  await Promise.all([loadChats(),loadFriends()]);connect();
}
const renderMe=()=>$('#me').innerHTML=`<div class="row" style="padding:0">${av(me.name,me.avatar)}<b>${esc(me.name)}</b></div>`;

// ---------- Data & lists ----------
async function loadChats(){chats=await api('/chats');renderList()}
async function loadFriends(){[friends,requests]=await Promise.all([api('/friends'),api('/friends/requests')]);renderList()}
function switchTab(t){tab=t;['chats','friends','find'].forEach(x=>$('#t-'+x).classList.toggle('on',x===t));$('#searchBox').hidden=t!=='find';renderList()}
function searchUsers(q){clearTimeout(timer);timer=setTimeout(async()=>{results=await api('/users/search?q='+encodeURIComponent(q)).catch(()=>[]);renderList()},300)}
function renderList(){
  const L=$('#list');
  if(tab==='chats')L.innerHTML=chats.map(c=>`<div class="row ${active===c.id?'sel':''}" onclick="openChat(${c.id})">${av(c.name,c.avatar,c.other?.online)}<div class="grow"><b>${esc(c.is_group?'👥 '+c.name:c.name)}</b><small>${c.last?esc(preview(c.last)):'No messages yet'}</small></div>${c.unread?`<span class="badge">${c.unread}</span>`:''}</div>`).join('')||'<p class="empty">No chats yet. Use the Find tab to add friends!</p>';
  else if(tab==='friends')L.innerHTML=(requests.length?'<h4>Friend requests</h4>':'')+requests.map(r=>`<div class="row">${av(r.user.name,r.user.avatar)}<div class="grow"><b>${esc(r.user.name)}</b><small>@${esc(r.user.username)}</small></div><button class="ok" onclick="respond(${r.id},true)">✓</button><button class="no" onclick="respond(${r.id},false)">✕</button></div>`).join('')+`<h4>Friends (${friends.length})</h4>`+friends.map(f=>`<div class="row" onclick="chatWith(${f.id})">${av(f.name,f.avatar,f.online)}<div class="grow"><b>${esc(f.name)}</b><small>${esc(f.bio||'@'+f.username)}</small></div><button class="no" onclick="event.stopPropagation();blockUser(${f.id})">Block</button></div>`).join('');
  else L.innerHTML=results.map(u=>`<div class="row">${av(u.name,u.avatar,u.online)}<div class="grow"><b>${esc(u.name)}</b><small>@${esc(u.username)}</small></div>${{none:`<button class="ok" onclick="addFriend(${u.id})">Add</button>`,sent:'<small>Pending</small>',received:'<small>Check Friends tab</small>',friend:'<small>Friends ✓</small>'}[u.relation]}</div>`).join('')||'<p class="empty">Type at least 2 letters to find people</p>';
}
async function addFriend(id){try{await api('/friends/request','POST',{user_id:id});toast('Friend request sent');results.find(u=>u.id===id).relation='sent';renderList()}catch(e){toast(e.message)}}
async function respond(id,accept){await api('/friends/respond','POST',{request_id:id,accept});await Promise.all([loadFriends(),loadChats()])}
async function blockUser(id){if(confirm('Block this user? They will not be able to message you.')){await api('/block','POST',{user_id:id});toast('User blocked')}}
function chatWith(uid){const c=chats.find(c=>!c.is_group&&c.other?.id===uid);if(c)openChat(c.id)}

// ---------- Chat view ----------
function openChat(id){
  active=id;cur().unread=0;document.body.classList.add('chat-open');$('#empty').hidden=true;$('#pane').hidden=false;renderHead();renderList();
  (msgs[id]?Promise.resolve():api(`/chats/${id}/messages`).then(m=>msgs[id]=m)).then(()=>{renderMsgs();markRead()});
}
function closeChat(){active=null;document.body.classList.remove('chat-open');renderList()}
function renderHead(){const c=cur();if(!c)return;const o=c.other;
  $('#head').innerHTML=`${av(c.name,c.avatar,o?.online)}<div><b>${esc(c.name)}</b><small>${c.is_group?c.members.map(m=>esc(m.name)).join(', '):o?.online?'online':'last seen '+new Date(o.last_seen).toLocaleString([],{dateStyle:'short',timeStyle:'short'})}</small></div>`}
function msgHTML(m,c){
  const mine=m.sender_id===me.id,s=c.members.find(u=>u.id===m.sender_id),u=esc(m.file_url);
  let b={image:`<img src="${u}" onclick="window.open(this.src)">`,video:`<video src="${u}" controls></video>`,audio:`<audio src="${u}" controls></audio>`,file:`<a href="${u}" download="${esc(m.file_name)}">📄 ${esc(m.file_name||'Document')}</a>`}[m.kind]||'';
  if(m.body)b+=`<div>${esc(m.body)}</div>`;
  return `<div class="msg ${mine?'me':'them'}">${c.is_group&&!mine?`<b class="who">${esc(s?.name||'')}</b>`:''}${b}<span class="meta">${time(m.created)} ${mine?`<span class="tick ${m.status}">${m.status==='sent'?'✓':'✓✓'}</span>`:''}</span></div>`}
function renderMsgs(){const c=cur(),box=$('#msgs');if(!c)return;box.innerHTML=(msgs[c.id]||[]).map(m=>msgHTML(m,c)).join('');box.scrollTop=box.scrollHeight}
const wsSend=o=>ws&&ws.readyState===1?ws.send(JSON.stringify(o)):toast('Reconnecting… try again');
const markRead=()=>active&&wsSend({type:'read',chat_id:active});
const toggleBtns=()=>{const t=$('#text').value.trim();$('#send').hidden=!t;$('#mic').hidden=!!t};
function sendText(){const b=$('#text').value.trim();if(!b||!active)return;wsSend({type:'message',chat_id:active,kind:'text',body:b});$('#text').value='';toggleBtns()}
async function upload(file){const fd=new FormData();fd.append('file',file);const r=await fetch('/api/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:fd});const d=await r.json();if(!r.ok)throw new Error(d.detail);return d}
async function sendFile(file){try{const d=await upload(file);wsSend({type:'message',chat_id:active,kind:d.kind,file_url:d.url,file_name:d.name})}catch(e){toast(e.message)}}
function pickFile(i){if(i.files[0])sendFile(i.files[0]);i.value=''}
async function toggleRec(){
  if(rec){rec.stop();return}
  try{const st=await navigator.mediaDevices.getUserMedia({audio:true}),parts=[];rec=new MediaRecorder(st);
    rec.ondataavailable=e=>parts.push(e.data);
    rec.onstop=async()=>{st.getTracks().forEach(t=>t.stop());const b=new Blob(parts,{type:rec.mimeType});rec=null;$('#mic').classList.remove('rec');await sendFile(new File([b],'voice.'+(b.type.includes('mp4')?'m4a':'webm'),{type:b.type}))};
    rec.start();$('#mic').classList.add('rec');toast('Recording… tap 🎤 again to send')}catch{toast('Microphone permission is needed')}}

// ---------- Real-time ----------
function connect(){
  ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws?token=${token}`);
  ws.onmessage=e=>handle(JSON.parse(e.data));
  ws.onclose=()=>{if(token)setTimeout(connect,2000)};
}
async function handle(d){
  if(d.type==='message'){
    const m=d.message;let c=chats.find(c=>c.id===m.chat_id);
    if(!c){await loadChats();c=chats.find(c=>c.id===m.chat_id);if(!c)return}
    if(msgs[m.chat_id])msgs[m.chat_id].push(m);
    c.last=m;const seen=active===c.id&&!document.hidden;
    if(m.sender_id!==me.id){if(seen)markRead();else{c.unread++;notify(c,m)}}
    chats.sort((a,b)=>(b.last?.created||'').localeCompare(a.last?.created||''));
    renderList();if(active===c.id)renderMsgs();
  }else if(d.type==='status'){
    (msgs[d.chat_id]||[]).forEach(m=>{if(d.ids.includes(m.id))m.status=d.status});if(active===d.chat_id)renderMsgs();
  }else if(d.type==='presence'){
    chats.forEach(c=>{c.members=c.members.map(u=>u.id===d.user.id?d.user:u);if(c.other?.id===d.user.id)c.other=d.user});
    friends=friends.map(u=>u.id===d.user.id?d.user:u);renderList();renderHead();
  }else if(d.type==='friend_request'){toast(d.user.name+' sent you a friend request');loadFriends()}
  else if(d.type==='friend_accepted'){toast(d.user.name+' accepted your request');loadFriends();loadChats()}
  else if(d.type==='chat_created'){toast('You were added to a group');loadChats()}
  else if(d.type==='error')toast(d.detail);
}
function notify(c,m){
  if('Notification' in window&&Notification.permission==='granted')new Notification(c.name,{body:preview(m)});
}

// ---------- Modals: groups & settings ----------
const modal=h=>{$('#modalBody').innerHTML=h;$('#modal').hidden=false};
const closeModal=()=>$('#modal').hidden=true;
function groupModal(){modal(`<h3>New group</h3><input id="gname" placeholder="Group name">${friends.map(f=>`<label class="row"><input type="checkbox" class="gm" value="${f.id}"> ${esc(f.name)}</label>`).join('')||'<p class="sub">Add some friends first.</p>'}<div class="actions"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="makeGroup()">Create</button></div>`)}
async function makeGroup(){try{await api('/groups','POST',{name:$('#gname').value,member_ids:[...document.querySelectorAll('.gm:checked')].map(x=>+x.value)});closeModal();await loadChats();switchTab('chats')}catch(e){toast(e.message)}}
async function settingsModal(){
  const bl=await api('/blocked');let avatar=me.avatar;
  modal(`<h3>Settings</h3><div class="row" style="padding:0">${av(me.name,me.avatar)}<label class="no" style="padding:6px 10px;border-radius:8px;cursor:pointer">Change photo<input type="file" accept="image/*" hidden id="pfile"></label></div>
  <input id="pname" value="${esc(me.name)}" placeholder="Name"><input id="puser" value="${esc(me.username)}" placeholder="Username"><input id="pbio" value="${esc(me.bio)}" placeholder="Bio">
  <label class="row" style="padding:4px 0"><input type="checkbox" style="width:auto" id="pdark" ${document.body.classList.contains('dark')?'checked':''}> Dark mode</label>
  <button class="no" onclick="Notification.requestPermission().then(p=>toast('Notifications '+p))">🔔 Enable notifications</button>
  <b>Blocked users</b>${bl.map(u=>`<div class="row" style="padding:2px 0"><span class="grow">${esc(u.name)}</span><button class="no" onclick="unblockUser(${u.id})">Unblock</button></div>`).join('')||'<small class="sub">None</small>'}
  <div class="actions"><button onclick="logout()">Log out</button><button class="primary" id="psave">Save</button></div>`);
  $('#pfile').onchange=async e=>{try{avatar=(await upload(e.target.files[0])).url;toast('Photo ready — press Save')}catch(x){toast(x.message)}};
  $('#pdark').onchange=e=>{document.body.classList.toggle('dark',e.target.checked);e.target.checked?localStorage.dark=1:localStorage.removeItem('dark')};
  $('#psave').onclick=async()=>{try{me=await api('/me','PUT',{name:$('#pname').value,username:$('#puser').value,bio:$('#pbio').value,avatar});renderMe();closeModal()}catch(e){toast(e.message)}};
}
async function unblockUser(id){await api('/unblock','POST',{user_id:id});settingsModal()}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)markRead()});
if(token)start();
