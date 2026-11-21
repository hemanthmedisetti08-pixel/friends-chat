/* ===== Group voice/video calls =====
   Signaling (who started a call, who joined) travels over the existing chat WebSocket.
   Media goes through a LiveKit SFU media server, so many people can talk without everyone connecting to everyone. */
const GC={room:null,chat:null,type:'audio',tick:null,started:0,micOn:true,camOn:false};
let gstate={},appInfo={},lkLoad=null,gRingT=null;
fetch('/api/app-info').then(r=>r.json()).then(i=>appInfo=i).catch(()=>{});
const loadLK=()=>window.LivekitClient?Promise.resolve():lkLoad||(lkLoad=new Promise((ok,no)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js';s.onload=ok;s.onerror=()=>{lkLoad=null;no(new Error('Could not load the call library. Check your connection.'))};document.head.append(s)}));

function startGroupCall(type){
  const c=cur();if(!c||!c.is_group)return;
  if(GC.room||GC.chat)return toast('You are already in a group call');
  if(!appInfo.group_calls)return toast('Group calls need a LiveKit media server, which is not set up yet (see the README).');
  if(!ws||ws.readyState!==1)return toast('Connecting… try again in a moment');
  const s=gstate[c.id];GC.chat=c.id;wsSend({type:s&&s.active?'gcall_join':'gcall_start',chat_id:c.id,call_type:type});
}
const joinGroupCall=id=>{if(GC.room||GC.chat)return;GC.chat=id;hideGRing();wsSend({type:'gcall_join',chat_id:id})};

/* "call in progress · Join" bar inside the group chat */
function renderGcallBar(c){
  const b=$('#gcallBar'),s=c&&c.is_group&&gstate[c.id],show=!!(s&&s.active&&GC.chat!==c.id);b.hidden=!show;
  if(show)b.innerHTML=`${s.call_type==='video'?'🎥':'📞'} Group ${s.call_type==='video'?'video':'voice'} call in progress · ${s.participants.length} in call <button class="callbtn green" onclick="joinGroupCall(${c.id})">Join</button>`;
}
function showGRing(d){
  if(GC.room||GC.chat)return;
  let el=$('#gincoming');if(!el){el=document.createElement('div');el.id='gincoming';el.className='incoming';el.style.zIndex=31;document.body.append(el)}
  el.innerHTML=`<div class="card"><div>${av(d.user.name,d.user.avatar)}</div><b>${esc(d.user.name)}</b><small class="sub">started a group ${d.call_type==='video'?'video':'voice'} call in “${esc(d.group)}”</small><div class="actions"><button class="callbtn red" onclick="hideGRing()">Dismiss</button><button class="callbtn green" onclick="joinGroupCall(${d.chat_id})">Join</button></div></div>`;
  el.hidden=false;ring(callAlerts());if(callAlerts()&&S.notif.vibrate&&navigator.vibrate)navigator.vibrate([300,150,300]);
  if(callAlerts()&&document.hidden&&'Notification' in window&&Notification.permission==='granted')new Notification(d.group,{body:d.user.name+' started a group call'});
  clearTimeout(gRingT);gRingT=setTimeout(hideGRing,45000);
}
function hideGRing(){const e=$('#gincoming');if(e)e.hidden=true;ring(false);clearTimeout(gRingT)}

async function handleGcall(d){
  if(d.type==='gcall_state'){
    gstate[d.chat_id]=d;if(active===d.chat_id&&cur())renderGcallBar(cur());
    if(!d.active&&!GC.room)hideGRing();if(GC.chat===d.chat_id&&GC.room)updateCount();
    const p=routeNow().split('/');if(p[1]==='group'&&+p[2]===d.chat_id)refreshGroup();return true;
  }
  if(d.type==='gcall_ring'){showGRing(d);return true}
  if(d.type==='gcall_error'){GC.chat=GC.room?GC.chat:null;toast(d.detail);return true}
  if(d.type==='gcall_token'){await joinRoom(d);return true}
  return false;
}

/* ---- call screen ---- */
function buildUI(d){
  let o=$('#gcall');
  if(!o){o=document.createElement('div');o.id='gcall';o.className='gcall';o.setAttribute('role','dialog');o.setAttribute('aria-label','Group call');
    o.innerHTML=`<div class="top"><b id="gName"></b><span id="gTimer">00:00</span><small id="gCount"></small></div><div id="gGrid" class="ggrid"></div><div id="gAudio" hidden></div><div class="controls"><button id="gMic" class="cbtn" title="Mute / unmute microphone" aria-label="Mute or unmute microphone" onclick="toggleGMic()">🎤</button><button id="gCam" class="cbtn" title="Camera on / off" aria-label="Camera on or off" onclick="toggleGCam()">📷</button><button class="cbtn end" title="Leave call" aria-label="Leave call" onclick="leaveGroupCall()">📵</button></div>`;document.body.append(o)}
  const c=chats.find(c=>c.id===d.chat_id);
  $('#gName').textContent=(c?c.name:'Group')+' · '+(d.call_type==='video'?'video':'voice')+' call';$('#gGrid').innerHTML='';$('#gAudio').innerHTML='';$('#gTimer').textContent='00:00';
  $('#gCam').hidden=d.call_type!=='video';$('#gMic').textContent='🎤';$('#gMic').classList.remove('off');$('#gCam').textContent='📷';$('#gCam').classList.remove('off');o.hidden=false;
}
function tile(p,local){
  const id='t_'+p.identity;let t=document.getElementById(id);
  if(!t){t=document.createElement('div');t.id=id;t.className='tile';const n=p.name||p.identity||'?';
    t.innerHTML=`<div class="tav">${esc(n[0].toUpperCase())}</div><div class="tmedia"></div><div class="tname"><span class="tmic"></span>${esc(n)}${local?' (You)':''}</div>`;$('#gGrid').append(t)}
  updateCount();return t;
}
function updateCount(){const r=GC.room;if(r&&$('#gCount'))$('#gCount').textContent=(r.remoteParticipants.size+1)+' in call'}
function setMedia(t,el,on){const m=t.querySelector('.tmedia');if(on){m.replaceChildren(el);t.classList.add('hasvideo')}else{m.replaceChildren();t.classList.remove('hasvideo')}}
function attachRemote(track,p){
  const t=tile(p),el=track.attach();
  if(track.kind==='video')setMedia(t,el,true);else $('#gAudio').append(el);
}
function markMute(pub,p){
  const t=document.getElementById('t_'+p.identity);if(!t)return;
  if(pub.kind==='audio')t.classList.toggle('muted',pub.isMuted);
  if(pub.kind==='video')t.classList.toggle('camoff',pub.isMuted);
}
async function joinRoom(d){
  hideGRing();if(GC.room)return;
  try{
    await loadLK();const L=window.LivekitClient,room=new L.Room({adaptiveStream:true,dynacast:true});
    GC.room=room;GC.chat=d.chat_id;GC.type=d.call_type;GC.micOn=true;GC.camOn=false;buildUI(d);
    room.on(L.RoomEvent.TrackSubscribed,(t,pub,p)=>attachRemote(t,p))
      .on(L.RoomEvent.TrackUnsubscribed,(t,pub,p)=>{t.detach().forEach(e=>e.remove());if(t.kind==='video')setMedia(tile(p),null,false)})
      .on(L.RoomEvent.ParticipantConnected,p=>tile(p))
      .on(L.RoomEvent.ParticipantDisconnected,p=>{const t=document.getElementById('t_'+p.identity);t&&t.remove();updateCount()})
      .on(L.RoomEvent.ActiveSpeakersChanged,sp=>{document.querySelectorAll('.tile').forEach(t=>t.classList.toggle('speaking',sp.some(s=>'t_'+s.identity===t.id)))})
      .on(L.RoomEvent.TrackMuted,markMute).on(L.RoomEvent.TrackUnmuted,markMute)
      .on(L.RoomEvent.LocalTrackPublished,(pub,p)=>{if(pub.kind==='video'&&pub.track){const el=pub.track.attach();el.classList.add('mirror');setMedia(tile(p,true),el,true)}})
      .on(L.RoomEvent.LocalTrackUnpublished,(pub,p)=>{if(pub.kind==='video')setMedia(tile(p,true),null,false)})
      .on(L.RoomEvent.Disconnected,()=>{if(GC.room===room){toast('Disconnected from the call');leaveGroupCall()}});
    await room.connect(d.url,d.token);await room.startAudio().catch(()=>{});
    tile(room.localParticipant,true);
    room.remoteParticipants.forEach(p=>{tile(p);p.trackPublications.forEach(pub=>pub.track&&attachRemote(pub.track,p))});
    try{await room.localParticipant.setMicrophoneEnabled(true)}catch(e){GC.micOn=false;$('#gMic').textContent='🔇';$('#gMic').classList.add('off');toast('Microphone permission is needed to talk')}
    if(d.call_type==='video'){try{await room.localParticipant.setCameraEnabled(true);GC.camOn=true}catch(e){GC.camOn=false;$('#gCam').textContent='🚫';$('#gCam').classList.add('off');toast('Camera not available: joined with audio only')}}
    GC.started=Date.now();GC.tick=setInterval(()=>{const s=Math.floor((Date.now()-GC.started)/1000);$('#gTimer').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')},1000);
    if(active===d.chat_id&&cur())renderGcallBar(cur());updateCount();
  }catch(e){toast(e.message||'Could not join the call');const ch=GC.chat;try{GC.room&&GC.room.disconnect()}catch(x){}GC.room=null;GC.chat=null;if(ch)wsSend({type:'gcall_leave',chat_id:ch});const o=$('#gcall');if(o)o.hidden=true}
}
async function toggleGMic(){
  if(!GC.room)return;const on=!GC.micOn;
  try{await GC.room.localParticipant.setMicrophoneEnabled(on);GC.micOn=on;$('#gMic').textContent=on?'🎤':'🔇';$('#gMic').classList.toggle('off',!on)}catch(e){toast('Could not change the microphone')}
}
async function toggleGCam(){
  if(!GC.room)return;const on=!GC.camOn;
  try{await GC.room.localParticipant.setCameraEnabled(on);GC.camOn=on;$('#gCam').textContent=on?'📷':'🚫';$('#gCam').classList.toggle('off',!on)}catch(e){toast('Could not change the camera')}
}
function leaveGroupCall(){
  const ch=GC.chat,room=GC.room;GC.room=null;GC.chat=null;clearInterval(GC.tick);
  try{room&&room.disconnect()}catch(e){}
  if(ch)wsSend({type:'gcall_leave',chat_id:ch});
  const o=$('#gcall');if(o)o.hidden=true;if($('#gAudio'))$('#gAudio').innerHTML='';
  if(active===ch&&cur())renderGcallBar(cur());
}
addEventListener('beforeunload',()=>{if(GC.chat&&ws&&ws.readyState===1)ws.send(JSON.stringify({type:'gcall_leave',chat_id:GC.chat}))});
