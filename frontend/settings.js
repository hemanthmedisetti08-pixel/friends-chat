/* ===== Friends Chat: Settings =====
   Every value is saved on the server (/api/settings) and applied by applySettings().
   Loaded after app.js and calls.js, so it can use their functions (api, toast, modal, chats, friends ...). */
const S0={privacy:{last_seen:'everyone',online:'everyone',photo:'everyone',about:'everyone',read_receipts:true,typing:true},security:{alerts:true},
chat:{theme:'system',wallpaper:'default',font_size:'medium',enter_send:true,list_preview:true},
media:{mobile:{image:true,audio:true,video:false,file:false},wifi:{image:true,audio:true,video:true,file:true},data_saver:false},
notif:{messages:true,groups:true,calls:true,sound:'chime',preview:true,desktop:true,vibrate:true},access:{font_scale:100,high_contrast:false,reduce_motion:false},chat_prefs:{}};
let S=(()=>{try{return Object.assign({},S0,JSON.parse(localStorage.fc_settings||'{}'))}catch(e){return S0}})();
const WALLS={mint:'linear-gradient(160deg,#d9fdd3,#b2ebf2)',sunset:'linear-gradient(160deg,#ffe0b2,#f8bbd0)',ocean:'linear-gradient(160deg,#bbdefb,#c5cae9)',forest:'linear-gradient(160deg,#c8e6c9,#a5d6a7)',night:'linear-gradient(160deg,#10212b,#1c3a4a)',graphite:'linear-gradient(160deg,#2b2f33,#40464c)'};
const LBL={image:'Photos',audio:'Audio',video:'Videos',file:'Documents'};
const bytes=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';
const ago=iso=>{const s=(Date.now()-new Date(iso))/1000;return s<90?'just now':s<3600?Math.round(s/60)+' min ago':s<86400?Math.round(s/3600)+' h ago':Math.round(s/86400)+' days ago'};
const cfg=k=>k.split('.').reduce((o,x)=>o&&o[x],S);
const desktop=()=>matchMedia('(min-width:900px)').matches;

/* ---------- apply settings to the whole site ---------- */
function wallCss(w){return w.startsWith('preset:')?WALLS[w.slice(7)]||'transparent':w.startsWith('color:')?w.slice(6):w.startsWith('url:')?`url(${w.slice(4)}) center/cover`:'transparent'}
function applySettings(){
  const a=S.access,c=S.chat,b=document.body,root=document.documentElement;
  const dark=c.theme==='dark'||(c.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
  b.classList.toggle('dark',dark);dark?localStorage.dark='1':localStorage.removeItem('dark');
  b.classList.toggle('hc',!!a.high_contrast);b.classList.toggle('calm',!!a.reduce_motion);
  root.style.setProperty('--ui-scale',a.font_scale/100);
  root.style.setProperty('--chat-scale',{small:.9,medium:1,large:1.2}[c.font_size]||1);
  root.style.setProperty('--wall',wallCss(c.wallpaper));
  try{localStorage.fc_settings=JSON.stringify(S)}catch(e){}
  if(typeof renderList==='function'&&me)renderList();
}
async function loadSettings(){S=Object.assign({},S0,await api('/settings'));applySettings()}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>S.chat.theme==='system'&&applySettings());
applySettings();
async function setVal(key,val,quiet){
  try{S=Object.assign({},S0,await api('/settings','PATCH',{values:{[key]:val}}));applySettings();if(!quiet)toast('Saved')}
  catch(e){toast(e.message);renderSection(true)}
}
const setExcept=k=>setVal(k+'_except',[...document.querySelectorAll(`input[name="ex_${k}"]:checked`)].map(x=>+x.value));
const liveScale=v=>{document.documentElement.style.setProperty('--ui-scale',v/100);const o=document.querySelector('output');if(o)o.textContent=v+'%'};

/* ---------- chat behaviour that depends on settings ---------- */
let viewArchived=false,typingAt={},lastTyping=0,loadedMedia=new Set(),sctx;
const isMuted=c=>c.muted_until==='forever'||(c.muted_until&&new Date(c.muted_until)>new Date());
const isTyping=id=>Date.now()-(typingAt[id]||0)<3500;
function onTextChange(){
  const t=$('#text');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,120)+'px';
  if(t.value.trim()&&active&&S.privacy.typing&&Date.now()-lastTyping>2500&&ws&&ws.readyState===1){lastTyping=Date.now();ws.send(JSON.stringify({type:'typing',chat_id:active}))}
}
function onTextKey(e){if(e.key==='Enter'&&!e.shiftKey&&S.chat.enter_send){e.preventDefault();sendText()}}
function headStatus(c){
  if(isTyping(c.id))return c.is_group?'someone is typing…':'typing…';
  if(c.is_group)return c.members.map(m=>esc(m.name)).join(', ');
  const o=c.other;if(!o)return '';
  return o.online?'online':o.last_seen?'last seen '+new Date(o.last_seen).toLocaleString([],{dateStyle:'short',timeStyle:'short'}):'';
}
function chatListHTML(){
  const list=chats.filter(c=>!!c.archived===viewArchived),n=chats.length-chats.filter(c=>!c.archived).length;
  const top=viewArchived?`<div class="row" tabindex="0" onclick="viewArchived=false;renderList()">← <b>Back to chats</b></div>`:n?`<div class="row" tabindex="0" onclick="viewArchived=true;renderList()">🗄️ <b>Archived</b><span class="grow"></span><span class="badge">${n}</span></div>`:'';
  return top+(list.map(c=>`<div class="row ${active===c.id?'sel':''}" tabindex="0" onclick="openChat(${c.id})" onkeydown="if(event.key==='Enter')openChat(${c.id})">${av(c.name,c.avatar,c.other?.online)}<div class="grow"><b>${esc(c.is_group?'👥 '+c.name:c.name)} ${isMuted(c)?'🔕':''}</b><small>${isTyping(c.id)?'typing…':c.last?(S.chat.list_preview?esc(preview(c.last)):'Message'):'No messages yet'}</small></div>${c.unread?`<span class="badge ${isMuted(c)?'mut':''}">${c.unread}</span>`:''}</div>`).join('')||'<p class="empty">'+(viewArchived?'No archived chats':'No chats yet. Use the Find tab to add friends!')+'</p>');
}
const currentNet=()=>{if(S.media.data_saver)return 'mobile';const c=navigator.connection;return c&&(c.type==='cellular'||c.saveData)?'mobile':'wifi'};
const mediaAllowed=k=>S.media[currentNet()][k];
function mediaHTML(m){
  const k=m.kind,u=esc(m.file_url);if(k==='text'||!m.file_url)return '';
  if(!(m.sender_id===me.id||mediaAllowed(k)||loadedMedia.has(m.id)))return `<button class="dlbtn" onclick="loadedMedia.add(${m.id});renderMsgs()">⬇ ${LBL[k]} · tap to download</button>`;
  return {image:`<img src="${u}" alt="Photo" onclick="window.open(this.src)">`,video:`<video src="${u}" controls></video>`,audio:`<audio src="${u}" controls></audio>`,file:`<a href="${u}" download="${esc(m.file_name)}">📄 ${esc(m.file_name||'Document')}</a>`}[k]||'';
}

/* ---------- notifications ---------- */
function playSound(n){
  if(n==='none')return;
  try{sctx=sctx||new (window.AudioContext||window.webkitAudioContext)();const t=sctx.currentTime;
    const tone=(f,s,d,f2)=>{const o=sctx.createOscillator(),g=sctx.createGain();o.frequency.setValueAtTime(f,t+s);if(f2)o.frequency.linearRampToValueAtTime(f2,t+s+d);g.gain.setValueAtTime(.12,t+s);g.gain.exponentialRampToValueAtTime(.001,t+s+d);o.connect(g);g.connect(sctx.destination);o.start(t+s);o.stop(t+s+d)};
    if(n==='chime'){tone(880,0,.25);tone(1320,.15,.35)}else if(n==='beep')tone(640,0,.25);else tone(400,0,.15,900)}catch(e){}
}
function notifyMsg(c,m){
  if(m.kind==='system')return;
  const n=S.notif;if(isMuted(c)||!(c.is_group?n.groups:n.messages))return;
  playSound(n.sound);if(n.vibrate&&navigator.vibrate)navigator.vibrate(120);
  if(n.desktop&&'Notification' in window&&Notification.permission==='granted')new Notification(c.name,{body:n.preview?preview(m):'New message'});
}
const callAlerts=()=>S.notif.calls!==false;
function handleExtra(d){
  if(String(d.type).startsWith('gcall_'))return handleGcall(d);
  if(d.type==='typing'){typingAt[d.chat_id]=Date.now();refreshTyping();setTimeout(refreshTyping,3600);return true}
  if(d.type==='security'){toast('🔐 '+d.text);if(S.notif.desktop&&'Notification' in window&&Notification.permission==='granted')new Notification('Security alert',{body:d.text});return true}
  if(d.type==='media_deleted'){(msgs[d.chat_id]||[]).forEach(m=>{if(d.ids.includes(m.id)){m.kind='text';m.body='🗑️ Media deleted';m.file_url='';m.file_name=''}});if(active===d.chat_id)renderMsgs();return true}
  if(d.type==='account_removed'){loadFriends();loadChats().then(()=>{if(active&&!cur())resetPane()});return true}
  return handleGroupEvent(d);
}
function refreshTyping(){renderList();if(active&&cur())renderHead()}
function resetPane(){hidePane();if(routeNow().startsWith('/chat/'))navReplace('/')}

/* ---------- small UI helpers ---------- */
const grp=(t,rows)=>`<div class="sgroup">${t?`<h4>${t}</h4>`:''}${rows}</div>`;
const note=t=>`<div class="note">${t}</div>`;
const act=(ic,l,d,fn,danger)=>`<div class="srow act ${danger?'danger':''}" tabindex="0" role="button" onclick="${fn}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"><span class="ic" aria-hidden="true">${ic}</span><div class="grow"><b>${l}</b><small>${d||''}</small></div><span class="chev" aria-hidden="true">›</span></div>`;
function formDlg(title,fields,ok,fn,hint,danger){
  modal(`<h3>${title}</h3>${hint?`<small class="sub">${hint}</small>`:''}${fields.map(f=>`<label class="fld"><span>${f.l}</span>${f.type==='textarea'?`<textarea id="fd_${f.n}" rows="5" maxlength="2000">${esc(f.v||'')}</textarea>`:`<input id="fd_${f.n}" type="${f.type||'text'}" value="${esc(f.v||'')}" autocomplete="${f.ac||'off'}" ${f.im?`inputmode="${f.im}"`:''}>`}</label>`).join('')}<div class="actions"><button onclick="closeModal()">Cancel</button><button class="${danger?'callbtn red':'primary'}" id="fdOk">${ok}</button></div>`);
  $('#fdOk').onclick=async()=>{const v={};fields.forEach(f=>v[f.n]=$('#fd_'+f.n).value);try{await fn(v);closeModal()}catch(e){toast(e.message)}};
}
function confirmDlg(title,text,ok,fn,danger=true){
  modal(`<h3>${title}</h3><p class="sub">${text}</p><div class="actions"><button onclick="closeModal()">Cancel</button><button class="callbtn ${danger?'red':'green'}" id="cfOk">${ok}</button></div>`);
  $('#cfOk').onclick=async()=>{try{await fn();closeModal()}catch(e){toast(e.message)}};
}
async function downloadApi(path,name){
  try{const r=await fetch('/api'+path,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).detail||'Download failed');
    const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)}catch(e){toast(e.message)}
}

/* ---------- settings definitions (one list drives rendering AND search) ---------- */
const VISO=[['everyone','Everyone'],['contacts','My contacts'],['contacts_except','My contacts except…'],['nobody','Nobody']];
const T=(k,l,d,x)=>Object.assign({t:'tog',k,l,d},x);
const DLF=[T('media.data_saver','Data saver','Always use the Mobile data rules, even on Wi-Fi'),...['mobile','wifi'].flatMap(n=>['image','audio','video','file'].map(t=>T(`media.${n}.${t}`,`${n==='mobile'?'Mobile data':'Wi-Fi'}: ${LBL[t]}`,'Download automatically (otherwise tap to download)')))];
const F={
 privacyVis:['last_seen:Last seen:Who can see when you were last online','online:Online status:Who can see when you are online','photo:Profile photo:Who can see your profile picture','about:About:Who can see your About text'].map(s=>{const[a,b,c]=s.split(':');return{t:'vis',k:'privacy.'+a,l:b,d:c}}),
 privacyMsg:[T('privacy.read_receipts','Read receipts','If off, others will not see blue ticks when you read their messages'),T('privacy.typing','Typing indicators','Show others when you are typing (and see theirs)')],
 sec:[T('security.alerts','Security notifications','Alert me about new logins and password or two-step changes')],
 chatDisp:[{t:'sel',k:'chat.theme',l:'Theme',d:'Light, dark or follow your device',o:[['light','Light'],['dark','Dark'],['system','System default']]},{t:'sel',k:'chat.font_size',l:'Chat font size',d:'Size of message text',o:[['small','Small'],['medium','Medium'],['large','Large']]}],
 chatType:[T('chat.enter_send','Enter key sends message','If off, Enter adds a new line (use the send button)'),T('chat.list_preview','Message preview in chat list','Show the last message under each chat name')],
 n1:[T('notif.messages','Message notifications','Sound and alerts for new messages'),T('notif.groups','Group notifications','Alerts for group messages'),T('notif.calls','Incoming call notifications','Ringtone, vibration and alert for calls (the call screen always appears)')],
 n2:[{t:'sel',k:'notif.sound',l:'Notification sound',d:'Played for new messages',o:[['chime','Chime'],['beep','Beep'],['pop','Pop'],['none','Silent']],after:'<button class="no" onclick="playSound(S.notif.sound)" aria-label="Play sound">▶</button>'},T('notif.preview','Message preview','Show message text inside notifications'),T('notif.desktop','Desktop notifications','Show pop-up notifications (needs browser permission)')],
 n3:[T('notif.vibrate','Vibration','Vibrate on new messages and calls',{show:()=>!!navigator.vibrate,off:'Vibration is not supported by this browser or device'})],
 acc:[{t:'range',k:'access.font_scale',l:'Font size',d:'Make all text smaller or larger'},T('access.high_contrast','High contrast','Stronger colors and borders'),T('access.reduce_motion','Reduce animations','Turn off transitions and movement')],
};
function fields(list){return list.map(f=>{
  const id='f_'+f.k.replace(/\W/g,'_'),v=cfg(f.k),lab=`<div class="grow"><b id="${id}l">${f.l}</b><small>${f.d||''}</small></div>`;
  if(f.show&&!f.show())return `<div class="srow"><div class="grow"><b>${f.l}</b><small>${f.off}</small></div></div>`;
  if(f.t==='tog')return `<div class="srow">${lab}<label class="sw"><input type="checkbox" role="switch" id="${id}" aria-labelledby="${id}l" ${v?'checked':''} onchange="setVal('${f.k}',this.checked)"><span></span></label></div>`;
  if(f.t==='sel')return `<div class="srow">${lab}<select aria-labelledby="${id}l" onchange="setVal('${f.k}',this.value)">${f.o.map(o=>`<option value="${o[0]}" ${o[0]===v?'selected':''}>${o[1]}</option>`).join('')}</select>${f.after||''}</div>`;
  if(f.t==='range')return `<div class="srow col">${lab}<div class="spread"><span aria-hidden="true">A</span><input type="range" min="80" max="150" step="5" value="${v}" aria-labelledby="${id}l" oninput="liveScale(this.value)" onchange="setVal('${f.k}',+this.value)"><span aria-hidden="true" style="font-size:1.5em">A</span><output>${v}%</output></div></div>`;
  const ex=cfg(f.k+'_except')||[];
  return `<div class="srow">${lab}<select aria-labelledby="${id}l" onchange="setVal('${f.k}',this.value).then(()=>renderSection(true))">${VISO.map(o=>`<option value="${o[0]}" ${o[0]===v?'selected':''}>${o[1]}</option>`).join('')}</select></div>`+(v==='contacts_except'?`<div class="except" role="group" aria-label="Hide ${f.l} from"><small>Hide from these contacts:</small>${friends.map(u=>`<label class="chk"><input type="checkbox" name="ex_${f.k}" value="${u.id}" ${ex.includes(u.id)?'checked':''} onchange="setExcept('${f.k}')"> ${esc(u.name)}</label>`).join('')||'<small>No friends yet</small>'}</div>`:'');
}).join('')}

const SECS=[['account','🔑','Account','Email, phone, password, delete account'],['privacy','🔒','Privacy','Last seen, photo, about, receipts, blocked'],['security','🛡️','Security','Two-step verification, devices, alerts'],['chats','💬','Chats','Theme, wallpaper, font size, archive'],['notifications','🔔','Notifications','Messages, calls, sounds, mute'],['storage','🗄️','Storage and data','Usage, media, auto-download'],['profile','👤','Profile','Photo, name, about'],['devices','💻','Linked devices','Where you are logged in'],['access','♿','Accessibility','Font size, contrast, motion'],['calls','📞','Call history','Recent voice and video calls'],['help','❓','Help and support','FAQ, contact, policies, app info']];
const TITLES={'calls':'Call history','chats:archive':'Archived chats','chats:clear':'Clear chat history','chats:delete':'Delete chats','notifications:mute':'Mute chats','help:faq':'FAQ','help:center':'Help center','help:privacy':'Privacy policy','help:terms':'Terms and conditions','help:about':'App information'};
const titleOf=n=>TITLES[n]||(SECS.find(s=>s[0]===n)||[])[2]||'';
const IDX=[];
Object.entries({privacy:[...F.privacyVis,...F.privacyMsg],security:F.sec,chats:[...F.chatDisp,...F.chatType,...DLF],notifications:[...F.n1,...F.n2,...F.n3],storage:DLF,access:F.acc}).forEach(([go,a])=>a.forEach(f=>IDX.push({go,l:f.l,d:f.d})));
[['account','Change email address'],['account','Change phone number'],['account','Change password'],['account','Download account information'],['account','Delete my account'],['account','Log out'],['account','Account security information'],['privacy','Blocked contacts'],['privacy','Default privacy settings'],['security','Two-step verification'],['security','Log out from other devices'],['security','Active devices'],['chats','Chat wallpaper'],['chats:archive','Archive chats'],['chats:clear','Clear chat history'],['chats:delete','Delete chat history'],['chats','Chat backup'],['notifications:mute','Mute notifications for contacts'],['notifications','Browser notification permission'],['storage','Storage usage'],['storage','Delete unnecessary media'],['storage','Data usage'],['profile','Change profile picture'],['profile','Remove profile picture'],['profile','Display name'],['profile','About information'],['profile','Preview profile'],['calls','Call history'],['devices','Linked devices'],['help:faq','Frequently asked questions'],['help:center','Help center'],['help','Contact support'],['help','Report a problem'],['help:privacy','Privacy policy'],['help:terms','Terms and conditions'],['help:about','Version information']].forEach(([go,l])=>IDX.push({go,l,d:''}));

/* ---------- settings page shell + navigation ---------- */
const SHELL=`<aside class="snav"><header><button class="icon" aria-label="Back to chats" onclick="closeSettings()">←</button><h2>Settings</h2></header>
<div class="sbox"><input id="sSearch" type="search" placeholder="Search settings" aria-label="Search settings" oninput="sFind(this.value)" autocomplete="off"></div>
<div class="sprof" tabindex="0" role="button" aria-label="Edit profile" onclick="go('profile')" onkeydown="if(event.key==='Enter')go('profile')"><div id="sAv"></div><div class="grow"><b id="sName"></b><small id="sSub"></small></div></div>
<div id="sMenu" role="navigation" aria-label="Settings categories"></div></aside>
<section class="smain"><header><button class="icon mback" aria-label="Back" onclick="sBack()">←</button><h3 id="sTitle"></h3></header><div id="sBody" tabindex="-1"></div></section>`;
let nav='',pd=null,lastFocus=null;
const menuHTML=()=>SECS.map(s=>`<div class="srow act ${nav.split(':')[0]===s[0]?'sel':''}" tabindex="0" role="button" onclick="go('${s[0]}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"><span class="ic" aria-hidden="true">${s[1]}</span><div class="grow"><b>${s[2]}</b><small>${s[3]}</small></div><span class="chev" aria-hidden="true">›</span></div>`).join('');
function sFind(q){
  q=q.trim().toLowerCase();const m=$('#sMenu');if(!q){m.innerHTML=menuHTML();return}
  const hits=IDX.filter(i=>(i.l+' '+(i.d||'')).toLowerCase().includes(q));
  m.innerHTML=hits.length?hits.map(i=>`<div class="srow act" tabindex="0" role="button" onclick="go('${i.go}')" onkeydown="if(event.key==='Enter'){this.click()}"><div class="grow"><b>${i.l}</b><small>${titleOf(i.go)}</small></div><span class="chev">›</span></div>`).join(''):'<p class="empty">No settings found</p>';
}
async function renderHeader(){
  $('#sAv').innerHTML=av(me.name,me.avatar);$('#sName').textContent=me.name;
  try{const a=await api('/account');$('#sSub').textContent=[a.phone,a.email].filter(Boolean).join(' · ')}catch(e){}
}
function openSettings(){lastFocus=document.activeElement;navPush(desktop()?'/settings/account':'/settings')}
function showSettings(n){   // called by the router (nav.js) for every /settings/... address
  let el=$('#settings');
  if(!el){el=document.createElement('div');el.id='settings';el.className='spage';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label','Settings');el.innerHTML=SHELL;document.body.append(el)}
  const opening=el.hidden;el.hidden=false;
  if(opening){pd=null;$('#sSearch').value='';renderHeader()}
  if(!n&&desktop()){navReplace('/settings/account');return}
  if(n.split(':')[0]!==nav.split(':')[0])pd=null;
  nav=n;el.classList.toggle('open',!!n);$('#sSearch').value='';$('#sMenu').innerHTML=menuHTML();
  if(n)renderSection();else $('#sTitle').textContent='';
  if(opening)setTimeout(()=>el.querySelector('.snav .icon').focus(),50);
}
function hideSettings(){const s=$('#settings');if(s&&!s.hidden){s.hidden=true;nav='';lastFocus&&lastFocus.focus&&lastFocus.focus()}}
const closeSettings=()=>navBack(active?'/chat/'+active:'/');
function go(n){const r='/settings/'+n.replace(':','/');if(desktop()&&!n.includes(':')&&routeNow().startsWith('/settings'))navReplace(r);else navPush(r)}
const sBack=()=>navBack();
async function renderSection(keep){
  const [sec,sub]=nav.split(':'),b=$('#sBody'),y=b.scrollTop;if(!sec)return;
  $('#sTitle').textContent=titleOf(nav);
  try{b.innerHTML=await R[sec](sub)}catch(e){b.innerHTML=`<p class="empty">${esc(e.message)}</p>`}
  b.scrollTop=keep?y:0;
}

/* ---------- the ten sections ---------- */
const R={};
R.account=async()=>{
  const a=await api('/account');
  return grp('',`<div class="sinfo"><div><small>Email</small><b>${esc(a.email)}</b></div><div><small>Phone</small><b>${esc(a.phone)}</b></div><div><small>Username</small><b>@${esc(a.username)}</b></div><div><small>Two-step verification</small><b>${a.two_step?'On':'Off'}</b></div><div><small>Friends · chats · messages sent</small><b>${a.friends} · ${a.chats} · ${a.messages_sent}</b></div><div><small>Active devices</small><b>${a.sessions}</b></div></div>`)
  +grp('Account',act('✉️','Change email address',esc(a.email),'chEmail()')+act('📱','Change phone number','Saved to your profile (not verified by SMS)','chPhone()')+act('🔑','Change password','Other devices are logged out','chPass()'))
  +grp('Your data',act('⬇️','Download account information','Profile, settings, friends, call history and chats (JSON)',"downloadApi('/account/export','friends-chat-account.json')"))
  +grp('Security information',note('Passwords are stored as salted PBKDF2-SHA256 hashes, never as plain text. Login tokens last 7 days and can be ended any time under Linked devices. Repeated wrong passwords are temporarily blocked. Turn on two-step verification in Security for extra protection.'))
  +grp('',act('🚪','Log out','Log out of this device','logout()')+act('🗑️','Delete my account','Permanently removes your account and data','delAccount()',true));
};
const chEmail=()=>formDlg('Change email address',[{n:'email',l:'New email',type:'email'},{n:'password',l:'Current password',type:'password',ac:'current-password'}],'Save',v=>api('/account/email','PUT',v).then(()=>{toast('Email updated');renderHeader();renderSection(true)}));
const chPhone=()=>formDlg('Change phone number',[{n:'phone',l:'New phone number',type:'tel'},{n:'password',l:'Current password',type:'password',ac:'current-password'}],'Save',v=>api('/account/phone','PUT',v).then(()=>{toast('Phone number updated');renderHeader();renderSection(true)}),'Phone numbers are not verified by SMS because that needs an SMS provider.');
const chPass=()=>formDlg('Change password',[{n:'current',l:'Current password',type:'password',ac:'current-password'},{n:'new',l:'New password (min 8 characters)',type:'password',ac:'new-password'},{n:'again',l:'Repeat new password',type:'password',ac:'new-password'}],'Change password',async v=>{if(v.new!==v.again)throw new Error('Passwords do not match');await api('/account/password','POST',{current:v.current,new:v.new});toast('Password changed. Other devices were logged out')});
async function delAccount(){
  const t=await api('/security/2fa'),f=[{n:'password',l:'Your password',type:'password',ac:'current-password'},{n:'confirm',l:'Type DELETE to confirm'}];if(t.enabled)f.push({n:'code',l:'Authenticator code',im:'numeric'});
  formDlg('Delete my account?',f,'Delete forever',async v=>{await api('/account/delete','POST',v);localStorage.removeItem('token');localStorage.removeItem('fc_settings');location.reload()},'This permanently deletes your profile, messages, uploaded files, friendships, call history and devices. 1-to-1 chats are removed for your friend too. This cannot be undone.',true);
}

R.privacy=async()=>{
  const bl=await api('/blocked'),free=friends.filter(f=>!bl.some(b=>b.id===f.id));
  return grp('Who can see my personal info',fields(F.privacyVis))+grp('Messaging',fields(F.privacyMsg))
  +grp('Blocked contacts ('+bl.length+')',bl.map(u=>`<div class="srow">${av(u.name,u.avatar)}<div class="grow"><b>${esc(u.name)}</b><small>@${esc(u.username)}</small></div><button class="no" onclick="blockOp('unblock',${u.id})">Unblock</button></div>`).join('')||'<div class="srow"><small>You have not blocked anyone</small></div>')
  +(free.length?grp('Block a friend',`<div class="srow"><select id="blkSel" aria-label="Choose a friend to block">${free.map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select><button class="no" onclick="blockOp('block',+$('#blkSel').value)">Block</button></div>`):'')
  +grp('',act('↩️','Default privacy settings','Reset visibility, read receipts and typing to the defaults',"confirmDlg('Reset privacy settings?','Everything in Privacy goes back to the default values.','Reset',()=>api('/settings/reset-privacy','POST').then(r=>{S=Object.assign({},S0,r);applySettings();renderSection(true)}),false)"))
  +note('Status/Stories is not part of this app, so there is no status privacy option. Blocked people cannot message or call you.');
};

R.security=async()=>{
  const [t,ss]=await Promise.all([api('/security/2fa'),api('/sessions')]);
  return grp('Two-step verification',`<div class="srow"><div class="grow"><b>Authenticator app</b><small>${t.enabled?'On: a 6-digit code is needed at login':'Off: login needs only your password'}</small></div><button class="${t.enabled?'no':'primary'}" onclick="${t.enabled?'tfaOff()':'tfaSetup()'}">${t.enabled?'Turn off':'Set up'}</button></div>`)
  +grp('Login and alerts',act('🔑','Change password','','chPass()')+fields(F.sec))
  +grp('Sessions',act('💻','Active devices',ss.length+' logged in',"go('devices')")+act('🚪','Log out from other devices','Ends every session except this one','logoutOthers()'))
  +grp('Account protection',note('Every login creates a session you can end at any time. Sessions expire after 7 days. Passwords are hashed, login attempts are rate-limited, and with two-step verification a stolen password alone cannot open your account.'));
};
async function tfaSetup(){
  const d=await api('/security/2fa/setup','POST');
  modal(`<h3>Set up two-step verification</h3><ol class="steps"><li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).</li><li>Add an account using this key, or tap the link on your phone:<div class="key" tabindex="0">${d.secret.match(/.{1,4}/g).join(' ')}</div><a href="${esc(d.uri)}">Open in authenticator app</a></li><li>Enter the 6-digit code it shows:</li></ol><input id="tfaCode" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" aria-label="6-digit code"><div class="actions"><button onclick="closeModal()">Cancel</button><button class="primary" id="tfaOk">Turn on</button></div>`);
  $('#tfaOk').onclick=async()=>{try{await api('/security/2fa/enable','POST',{code:$('#tfaCode').value});closeModal();toast('Two-step verification is on');renderSection(true)}catch(e){toast(e.message)}};
}
const tfaOff=()=>formDlg('Turn off two-step verification',[{n:'password',l:'Password',type:'password',ac:'current-password'},{n:'code',l:'Authenticator code',im:'numeric'}],'Turn off',v=>api('/security/2fa/disable','POST',v).then(()=>{toast('Two-step verification is off');renderSection(true)}),'',true);
const logoutOthers=()=>confirmDlg('Log out other devices?','Every device except this one will be logged out immediately.','Log out others',()=>api('/sessions/revoke-others','POST').then(r=>{toast(r.logged_out+' device(s) logged out');renderSection(true)}));

R.chats=async(sub)=>{
  if(sub)return chatManager(sub);
  const w=S.chat.wallpaper,arch=chats.filter(c=>c.archived).length;
  return grp('Display',fields(F.chatDisp)+`<div class="srow col"><div><b>Chat wallpaper</b><small>Shown behind your messages</small></div><div class="walls"><button class="wall ${w==='default'?'on':''}" onclick="setVal('chat.wallpaper','default').then(()=>renderSection(true))">Default</button>${Object.keys(WALLS).map(n=>`<button class="wall ${w==='preset:'+n?'on':''}" style="background:${WALLS[n]}" title="${n}" aria-label="${n} wallpaper" onclick="setVal('chat.wallpaper','preset:${n}').then(()=>renderSection(true))"></button>`).join('')}<label class="wall pick" title="Pick a color">🎨<input type="color" aria-label="Custom wallpaper color" onchange="setVal('chat.wallpaper','color:'+this.value).then(()=>renderSection(true))"></label><label class="wall pick" title="Upload an image">🖼️<input type="file" accept="image/*" hidden aria-label="Upload wallpaper" onchange="wallUpload(this)"></label></div></div>`)
  +grp('Typing',fields(F.chatType))+grp('Media auto-download',fields(DLF))
  +grp('Chat history',act('🗄️','Archived chats',arch+' archived',"go('chats:archive')")+act('🧹','Clear chat history','Remove messages from a chat (only for you)',"go('chats:clear')")+act('🗑️','Delete chats','Remove a chat and its history from your list',"go('chats:delete')"))
  +grp('Chat backup',act('💾','Back up all chats','Download every chat as a JSON file',"downloadApi('/chats/export','friends-chat-backup.json')")+note('Your chats are always stored on the server. A backup file is a text copy you keep yourself (media files are not included).'));
};
async function wallUpload(i){if(!i.files[0])return;try{const d=await upload(i.files[0]);await setVal('chat.wallpaper','url:'+d.url);renderSection(true)}catch(e){toast(e.message)}}
const muteLabel=c=>isMuted(c)?(c.muted_until==='forever'?'Muted always':'Muted until '+new Date(c.muted_until).toLocaleString([],{dateStyle:'short',timeStyle:'short'})):'Not muted';
function chatManager(mode){
  const intro={archive:'Archived chats are hidden from your main list.',mute:'Muted chats make no sound and show no pop-ups.',clear:'Clearing removes the messages for you only; your friend keeps theirs.',delete:'Deleting removes the chat from your list. It returns if a new message arrives.'}[mode];
  return note(intro)+grp('',chats.map(c=>`<div class="srow">${av(c.name,c.avatar)}<div class="grow"><b>${esc(c.name)}</b><small>${mode==='mute'?muteLabel(c):c.is_group?'Group':'Chat'}</small></div>`+({
    archive:`<button class="no" onclick="setArch(${c.id},${!c.archived})">${c.archived?'Unarchive':'Archive'}</button>`,
    mute:`<select aria-label="Mute ${esc(c.name)}" onchange="setMute(${c.id},this.value)"><option value="keep">${muteLabel(c)}</option><option value="">Unmute</option><option value="8h">8 hours</option><option value="1w">1 week</option><option value="forever">Always</option></select>`,
    clear:`<button class="no" onclick="clearChat(${c.id})">Clear</button>`,delete:`<button class="no" onclick="delChat(${c.id})">Delete</button>`}[mode])+'</div>').join('')||'<div class="srow"><small>No chats yet</small></div>');
}
const afterChat=()=>loadChats().then(()=>renderSection(true));
const setArch=(id,v)=>api(`/chats/${id}/prefs`,'PUT',{archived:v}).then(afterChat).catch(e=>toast(e.message));
function setMute(id,v){if(v==='keep')return;const u=v===''?'':v==='forever'?'forever':new Date(Date.now()+(v==='8h'?8*36e5:7*864e5)).toISOString();api(`/chats/${id}/prefs`,'PUT',{muted_until:u}).then(afterChat).catch(e=>toast(e.message))}
const clearChat=id=>confirmDlg('Clear this chat?','All messages are removed for you only. Your friend keeps their copy.','Clear',async()=>{await api(`/chats/${id}/clear`,'POST');msgs[id]=[];await loadChats();if(active===id)renderMsgs();if($('#settings')&&!$('#settings').hidden)renderSection(true)});
const delChat=id=>confirmDlg('Delete this chat?','The chat and its history are removed from your list. Your friend keeps their copy.','Delete',async()=>{await api(`/chats/${id}/delete`,'POST');delete msgs[id];await loadChats();if(active===id)resetPane();if($('#settings')&&!$('#settings').hidden)renderSection(true)});
function chatMenu(){
  const c=cur();if(!c)return;const o=c.other;
  modal(`<h3>${esc(c.name)}</h3><div class="menu">${c.is_group?`<button class="no" onclick="closeModal();navPush('/group/${c.id}')">ℹ️ Group info</button>`:`<button class="no" onclick="closeModal();navPush('/profile/${o.id}')">👤 View profile</button><button class="${c.blocked_by_me?'no':'callbtn red'}" onclick="closeModal();toggleBlock(${o.id})">${c.blocked_by_me?'✅ Unblock':'🚫 Block'}</button>`}<button class="no" onclick="closeModal();setArch(${c.id},${!c.archived})">${c.archived?'🗄️ Unarchive':'🗄️ Archive'}</button><label class="fld"><span>🔕 Mute notifications</span><select onchange="closeModal();setMute(${c.id},this.value)"><option value="keep">${muteLabel(c)}</option><option value="">Unmute</option><option value="8h">8 hours</option><option value="1w">1 week</option><option value="forever">Always</option></select></label><button class="no" onclick="closeModal();downloadApi('/chats/export?chat_id=${c.id}','chat-backup.json')">💾 Back up this chat</button><button class="no" onclick="clearChat(${c.id})">🧹 Clear chat</button><button class="no" onclick="delChat(${c.id})">🗑️ Delete chat (for me)</button>${c.is_group?`<button class="callbtn red" onclick="closeModal();exitGroup(${c.id})">🚪 Exit group</button>`:''}</div><div class="actions"><button onclick="closeModal()">Close</button></div>`);
}

R.notifications=async(sub)=>{
  if(sub==='mute')return chatManager('mute');
  const p='Notification' in window?Notification.permission:'unsupported';
  const pm={granted:'Allowed in this browser',denied:'Blocked: change it in your browser’s site settings',default:'Not asked yet',unsupported:'This browser does not support notifications'}[p];
  return grp('Alerts',fields(F.n1))+grp('Sound',fields(F.n2.slice(0,2)))
  +grp('Browser notifications',fields(F.n2.slice(2))+`<div class="srow"><div class="grow"><b>Browser permission</b><small>${pm}</small></div>${p==='default'?'<button class="primary" onclick="Notification.requestPermission().then(()=>renderSection(true))">Allow</button>':''}</div>`)
  +grp('Vibration',fields(F.n3))+grp('Mute',act('🔕','Mute notifications for contacts','Choose chats to mute for 8 hours, a week or always',"go('notifications:mute')"));
};

R.storage=async()=>{
  const d=await api('/storage'),tot=d.total_bytes||1,c=navigator.connection;
  return grp('Storage usage',`<div class="srow col"><div class="spread"><b>Media in your chats</b><span>${bytes(d.total_bytes)}</span></div><small>Sent by you ${bytes(d.sent_bytes)} · received ${bytes(d.received_bytes)}</small></div>`+['image','video','audio','file'].map(k=>`<div class="srow col"><div class="spread"><b>${LBL[k]}</b><span>${bytes(d.categories[k].bytes)} · ${d.categories[k].count}</span></div><div class="bar" role="img" aria-label="${LBL[k]} ${Math.round(d.categories[k].bytes/tot*100)} percent"><i style="width:${Math.round(d.categories[k].bytes/tot*100)}%"></i></div></div>`).join('')+(d.missing?`<div class="srow"><small>${d.missing} file(s) are no longer on the server (free hosting clears uploads on redeploy).</small></div>`:''))
  +grp('Data usage',note(`Browser connection: ${c?`${esc(c.type||'unknown')} · ${esc(c.effectiveType||'')} · ${c.downlink?c.downlink+' Mbps':''} ${c.saveData?'· Data Saver on':''}`:'not reported by this browser'}. Websites cannot measure total network usage; check your phone’s Settings › Data usage for exact numbers. Currently using the <b>${currentNet()==='mobile'?'Mobile data':'Wi-Fi'}</b> download rules.`))
  +grp('Automatic media download',fields(DLF))
  +grp('Delete unnecessary media',`<div class="srow"><select id="clKind" aria-label="Media type"><option value="all">All media</option>${Object.entries(LBL).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select><select id="clAge" aria-label="Older than"><option value="0">Any age</option><option value="7">Older than 7 days</option><option value="30">Older than 30 days</option><option value="90">Older than 90 days</option></select><button class="callbtn red" onclick="cleanupMedia()">Delete</button></div>`+note('Only files you sent can be deleted. Received media belongs to the sender; clear the chat to hide it.'))
  +grp('Manage media ('+d.files.length+')',d.files.map(f=>{const ch=chats.find(c=>c.id===f.chat_id);return `<div class="srow"><span class="ic" aria-hidden="true">${{image:'🖼️',video:'🎬',audio:'🎤',file:'📄'}[f.kind]}</span><div class="grow"><b>${esc(f.name||LBL[f.kind])}</b><small>${f.missing?'File no longer on server':bytes(f.size)} · ${f.mine?'sent by you':'received'} · ${esc(ch?ch.name:'')} · ${ago(f.created)}</small></div>${f.mine?`<button class="no" aria-label="Delete ${esc(f.name||'file')}" onclick="delMedia(${f.id})">Delete</button>`:''}</div>`}).join('')||'<div class="srow"><small>No media yet</small></div>');
};
const delMedia=id=>confirmDlg('Delete this file?','It is removed from the server for everyone in the chat.','Delete',()=>api('/media/'+id,'DELETE').then(()=>renderSection(true)));
const cleanupMedia=()=>confirmDlg('Delete media?','All matching files you sent are removed from the server for everyone in those chats.','Delete',()=>api('/media/cleanup','POST',{kind:$('#clKind').value,older_than_days:+$('#clAge').value}).then(r=>{toast(`Deleted ${r.deleted} file(s), freed ${bytes(r.freed_bytes)}`);renderSection(true)}));

R.profile=async()=>{
  pd=pd||{name:me.name,username:me.username,bio:me.bio||'',avatar:me.avatar||''};
  return `<div class="pcard"><div class="pav">${av(pd.name,pd.avatar)}</div><div class="actions"><label class="no btnlike" tabindex="0">Change photo<input type="file" accept="image/*" hidden aria-label="Choose profile photo" onchange="pPhoto(this)"></label><button class="no" onclick="pd.avatar='';renderSection(true)">Remove photo</button></div></div>`
  +grp('',`<label class="fld"><span>Display name</span><input maxlength="80" value="${esc(pd.name)}" oninput="pd.name=this.value"></label><label class="fld"><span>Username</span><input maxlength="30" value="${esc(pd.username)}" oninput="pd.username=this.value" autocapitalize="off"></label><label class="fld"><span>About</span><input maxlength="200" value="${esc(pd.bio)}" oninput="pd.bio=this.value"></label>`)
  +`<div class="actions pact"><button onclick="pd=null;renderSection(true)">Cancel</button><button class="no" onclick="pPreview()">Preview</button><button class="primary" onclick="pSave()">Save changes</button></div>`
  +grp('Contact details',act('✉️','Email address','Change it with your password','chEmail()')+act('📱','Phone number','Change it with your password','chPhone()'));
};
async function pPhoto(i){if(!i.files[0])return;try{pd.avatar=(await upload(i.files[0])).url;renderSection(true)}catch(e){toast(e.message)}}
async function pSave(){try{me=await api('/me','PUT',{name:pd.name,username:pd.username,bio:pd.bio,avatar:pd.avatar});pd=null;renderMe();renderHeader();toast('Profile saved');renderSection(true)}catch(e){toast(e.message)}}
async function pPreview(){
  const p=await api('/profile/preview'),card=(t,v)=>`<div class="pcard v"><small>${t}</small>${av(v.name,v.avatar)}<b>${esc(v.name)}</b><small>@${esc(v.username)}</small><p>${esc(v.bio)||'<i>About hidden or empty</i>'}</p><small>${v.online?'Online status visible':'Online status hidden'} · ${v.last_seen?'Last seen visible':'Last seen hidden'}</small></div>`;
  modal(`<h3>Profile preview</h3>${card('How your contacts see you',p.contact)}${card('How everyone else sees you',p.everyone)}<div class="actions"><button onclick="closeModal()">Close</button></div>`);
}

R.calls=async()=>{const l=await api('/calls?limit=50');return grp('Recent calls',l.map(c=>`<div class="srow"><span class="ic" aria-hidden="true">${c.call_type==='video'?'🎥':'📞'}</span><div class="grow"><b>${c.outgoing?'↗':'↙'} ${esc(c.peer)}</b><small>${esc(c.status)}${c.duration?' · '+fmt(c.duration*1000):''} · ${new Date(c.started).toLocaleString([],{dateStyle:'short',timeStyle:'short'})}</small></div></div>`).join('')||'<div class="srow"><small>No calls yet</small></div>')+note('Group calls appear as messages inside the group chat.')};
R.devices=async()=>{
  const ss=await api('/sessions'),row=s=>`<div class="srow"><span class="ic" aria-hidden="true">${/Android|iOS/.test(s.device)?'📱':'💻'}</span><div class="grow"><b>${esc(s.device)} ${s.current?'<span class="badge">This device</span>':''}</b><small>IP ${esc(s.ip||'unknown')} · active ${ago(s.last_active)} · signed in ${new Date(s.created).toLocaleDateString()}</small></div><button class="no" onclick="endSession('${s.id}',${s.current})">Log out</button></div>`;
  const cur=ss.filter(s=>s.current),oth=ss.filter(s=>!s.current);
  return grp('This device',cur.map(row).join(''))+grp('Other devices ('+oth.length+')',oth.map(row).join('')||'<div class="srow"><small>No other devices are logged in</small></div>')+(oth.length?grp('',act('🚪','Log out all other devices','',"logoutOthers()")):'')+note('Devices are real login sessions. Logging one out ends it immediately.');
};
const endSession=(id,isCur)=>confirmDlg(isCur?'Log out of this device?':'Log out this device?','The session ends immediately.','Log out',async()=>{await api('/sessions/'+id,'DELETE');if(isCur){logout()}else renderSection(true)});

R.access=()=>grp('Display',fields(F.acc)+`<div class="srow"><button class="no" onclick="setVal('access.font_scale',100).then(()=>renderSection(true))">Reset font size to 100%</button></div>`)
 +grp('Keyboard and screen readers',note('• <b>Tab</b> / <b>Shift+Tab</b> move between controls; <b>Enter</b> or <b>Space</b> activates them; <b>Esc</b> closes windows.<br>• Buttons, switches, fields and alerts have text labels for screen readers (TalkBack, NVDA, VoiceOver).<br>• “Reduce animations” also follows your device setting automatically.'));

const FAQ=[['How do I add a friend?','Open the Find tab, search a name or @username and press Add. They accept in the Friends tab, then you can chat.'],['Why can’t I see someone’s last seen or photo?','They may have limited who can see it in Privacy settings. If you hide yours, you still see theirs.'],['Why does a call stay on “Connecting…”?','Some networks block direct connections. The site owner must configure a TURN server for calls to work everywhere.'],['What do the ticks mean?','✓ sent, ✓✓ delivered, blue ✓✓ read. If someone turns off read receipts you will not see blue ticks.'],['How do I delete my account?','Settings › Account › Delete my account. Your data is permanently removed.'],['I forgot my password','Password reset by email is not available yet. Contact support from Help and support.']];
const policy=(t,body)=>note(`<b>${t}</b><br>${body}<br><br><i>This is a template. Replace it with text reviewed by a legal professional before launching publicly.</i>`);
R.help=async(sub)=>{
  if(sub==='faq')return grp('',FAQ.map(q=>`<details class="faq"><summary>${q[0]}</summary><p>${q[1]}</p></details>`).join(''));
  if(sub==='center')return grp('Getting started',note('1. <b>Find</b> friends and send a request.<br>2. Open a chat and send text, photos, videos, documents or voice messages.<br>3. Tap 📞 or 🎥 for a voice or video call.<br>4. Use ⚙️ Settings to control privacy, notifications, storage and security.'));
  if(sub==='privacy')return policy('Privacy policy','We store the information you give us (name, email, phone, profile, messages and files you send) to run the chat service. Audio and video calls go directly between devices and are not recorded. You can download or permanently delete your data in Settings › Account. We do not sell your data.');
  if(sub==='terms')return policy('Terms and conditions','By using Friends Chat you agree to use it lawfully and respectfully, not to harass others or share illegal content, and that accounts that break these rules may be removed. The service is provided “as is”.');
  if(sub==='about'){const i=await api('/app-info').catch(()=>({}));return grp('',`<div class="sinfo"><div><small>App</small><b>${esc(i.name||'Friends Chat')}</b></div><div><small>Version</small><b>${esc(i.version||'')}</b></div><div><small>Your browser</small><b>${esc(navigator.userAgent.slice(0,60))}</b></div></div>`);}
  const i=await api('/app-info').catch(()=>({}));
  return grp('Help',act('📘','Help center','Getting started',"go('help:center')")+act('💡','Frequently asked questions','Quick answers',"go('help:faq')"))
  +grp('Contact',act('✉️','Contact support',i.support_email?esc(i.support_email):'Send us a message',"supportDlg('support')")+act('🐞','Report a problem','Tell us what went wrong',"supportDlg('problem')"))
  +grp('About',act('🔏','Privacy policy','',"go('help:privacy')")+act('📄','Terms and conditions','',"go('help:terms')")+act('ℹ️','App information',`Version ${esc(i.version||'')}`,"go('help:about')"));
};
const supportDlg=k=>formDlg(k==='problem'?'Report a problem':'Contact support',[{n:'message',l:'Your message',type:'textarea'}],'Send',v=>api('/support','POST',{kind:k,message:v.message}).then(()=>toast('Thank you! Your message was sent')),'Your message is saved for the site owner together with your browser type.');

/* ---------- accessibility: keyboard + screen-reader helpers ---------- */
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  if(!$('#modal').hidden)closeModal();else{const s=$('#settings');if(s&&!s.hidden)sBack()}
});
function labelIcons(){
  document.querySelectorAll('button[title],label[title]').forEach(b=>!b.getAttribute('aria-label')&&b.setAttribute('aria-label',b.title));
  const set=(s,l)=>{const e=document.querySelector(s);e&&e.setAttribute('aria-label',l)};
  set('#pane .back','Back to chat list');set('#file','Attach photo, video or document');set('#send','Send message');set('#me','Open settings');
}
labelIcons();
