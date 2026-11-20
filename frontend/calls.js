/* Voice & video calling with WebRTC.
   - Signaling (who calls whom, offer/answer/ICE) travels through the SAME chat WebSocket (`ws` from app.js).
   - Audio/video itself goes directly browser-to-browser (peer-to-peer), never through our server. */
let call=null,iceCfg=null,ringTimer=null,callTick=null,endedT=null,actx=null;
const $c=id=>document.getElementById(id);
const fmt=ms=>{const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60,p=n=>String(n).padStart(2,'0');return (h?h+':':'')+p(m)+':'+p(x)};
const setStatus=t=>$c('callStatus').textContent=t;
const sendSig=data=>wsSend({type:'call_signal',call_id:call.id,data});

/* ---- ringtone (generated with WebAudio, no audio file needed) ---- */
function ring(on){
  clearInterval(ringTimer);ringTimer=null;if(!on)return;
  const beep=()=>{try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();const o=actx.createOscillator(),g=actx.createGain();o.frequency.value=480;g.gain.value=.08;o.connect(g);g.connect(actx.destination);o.start();o.stop(actx.currentTime+.35)}catch(e){}};
  beep();ringTimer=setInterval(beep,1500);
}

/* ---- microphone / camera ---- */
async function getMedia(type,facing='user'){
  if(!navigator.mediaDevices||!window.RTCPeerConnection)throw new Error('Calls need a modern browser and a secure (HTTPS) connection');
  try{return await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:type==='video'?{facingMode:facing,width:{ideal:1280},height:{ideal:720}}:false})}
  catch(e){const w=type==='video'?'camera and microphone':'microphone';throw new Error(e.name==='NotAllowedError'?'Please allow '+w+' access to make calls':'Could not access your '+w)}
}
const stopStream=s=>s&&s.getTracks().forEach(t=>t.stop());

/* ---- screens ---- */
function showCall(){
  const p=call.peer,v=call.type==='video',box=$c('call');
  clearTimeout(endedT);box.hidden=false;box.className='call '+(v?'video':'audio');
  $c('callAv').innerHTML=av(p.name,p.avatar);$c('callName').textContent=p.name;
  $c('callTimer').hidden=true;$c('callTimer').textContent='00:00';
  $c('localVid').srcObject=v?call.local:null;$c('localVid').classList.remove('rear');
  $c('btnCam').hidden=!v;$c('btnFlip').hidden=true;
  for(const b of ['btnMute','btnCam']){$c(b).classList.remove('off')}
  $c('btnMute').textContent='🎤';$c('btnCam').textContent='📷';
  if(v)navigator.mediaDevices.enumerateDevices().then(d=>$c('btnFlip').hidden=d.filter(x=>x.kind==='videoinput').length<2).catch(()=>{});
}
function showEnded(text){
  const box=$c('call');box.className=box.className.replace(' live','')+' ended';
  setStatus(text);$c('callTimer').hidden=true;
  clearTimeout(endedT);endedT=setTimeout(()=>{box.hidden=true},2600);
}

/* ---- starting a call (caller) ---- */
async function startCall(type){
  const c=cur();if(!c||c.is_group||!c.other)return;
  if(call)return toast('You are already in a call');
  if(!ws||ws.readyState!==1)return toast('Connecting to server… try again in a moment');
  let local;
  try{local=await getMedia(type)}catch(e){return toast(e.message)}
  const cl=call={id:null,peer:c.other,type,role:'caller',local,facing:'user',muted:false,camOff:false};
  showCall();setStatus('Calling…');
  try{iceCfg=await api('/ice')}catch(e){if(call===cl){teardown();$c('call').hidden=true}return toast('Could not start the call')}
  if(call!==cl)return;
  wsSend({type:'call_invite',to:c.other.id,call_type:type});
}

/* ---- incoming call (callee) ---- */
function onIncoming(d){
  if(call){wsSend({type:'call_reject',call_id:d.call_id});return}
  call={id:d.call_id,peer:d.user,type:d.call_type,role:'callee',accepted:false};
  $c('inAv').innerHTML=av(d.user.name,d.user.avatar);$c('inName').textContent=d.user.name;
  $c('inType').textContent='Incoming '+(d.call_type==='video'?'video':'voice')+' call…';
  $c('incoming').hidden=false;ring(callAlerts());if(callAlerts()&&S.notif.vibrate&&navigator.vibrate)navigator.vibrate([300,150,300]);
  if(callAlerts()&&document.hidden&&'Notification' in window&&Notification.permission==='granted')new Notification(d.user.name,{body:'Incoming '+d.call_type+' call'});
}
async function acceptCall(){
  const cl=call;if(!cl||cl.accepted)return;
  cl.accepted=true;ring(false);$c('incoming').hidden=true;
  try{
    const local=await getMedia(cl.type);
    if(call!==cl){stopStream(local);return}        // caller hung up while we were asking for permission
    cl.local=local;cl.facing='user';cl.muted=false;cl.camOff=false;
    showCall();setStatus('Connecting…');
    iceCfg=await api('/ice');
    if(call!==cl)return;
    cl.pc=makePC();
    wsSend({type:'call_accept',call_id:cl.id});
  }catch(e){
    toast(e.message);
    if(call===cl){wsSend({type:'call_reject',call_id:cl.id});teardown();$c('call').hidden=true}
  }
}
function rejectCall(){if(!call)return;wsSend({type:'call_reject',call_id:call.id});teardown()}

/* ---- WebRTC connection ---- */
function makePC(){
  const pc=new RTCPeerConnection({iceServers:iceCfg.iceServers}),cl=call;
  cl.local.getTracks().forEach(t=>pc.addTrack(t,cl.local));
  pc.onicecandidate=e=>{if(e.candidate&&call===cl)sendSig({candidate:e.candidate})};
  pc.ontrack=e=>{$c('remoteVid').srcObject=e.streams[0]};
  pc.onconnectionstatechange=()=>{
    if(call!==cl)return;
    if(pc.connectionState==='connected')onConnected();
    else if(pc.connectionState==='disconnected')setStatus('Reconnecting…');
    else if(pc.connectionState==='failed')endCall('Connection failed. This network may need a TURN server.');
  };
  cl.connTimer=setTimeout(()=>{if(call===cl&&!cl.connected)endCall('Could not connect. Please try again.')},35000);
  return pc;
}
function onConnected(){
  if(!call||call.connected)return;
  call.connected=true;call.startedAt=Date.now();clearTimeout(call.connTimer);
  setStatus('Connected');$c('call').classList.add('live');$c('callTimer').hidden=false;
  wsSend({type:'call_connected',call_id:call.id});
  callTick=setInterval(()=>{if(call)$c('callTimer').textContent=fmt(Date.now()-call.startedAt)},1000);
}
async function onSignal(d){
  if(!call||call.id!==d.call_id||!call.pc)return;
  const s=d.data,pc=call.pc;
  if(s.sdp){
    await pc.setRemoteDescription(s.sdp);
    if(s.sdp.type==='offer'){const a=await pc.createAnswer();await pc.setLocalDescription(a);sendSig({sdp:pc.localDescription})}
    for(const c of call.queue||[])await pc.addIceCandidate(c).catch(()=>{});call.queue=[];
  }else if(s.candidate){
    if(pc.remoteDescription)await pc.addIceCandidate(s.candidate).catch(()=>{});
    else(call.queue=call.queue||[]).push(s.candidate);    // candidate arrived early: keep it until the offer/answer is set
  }
}

/* ---- events from the server ---- */
async function handleCall(d){
  try{
    if(d.type==='call_incoming')return onIncoming(d);
    if(d.type==='call_ringing'){
      if(!call||call.id){wsSend({type:'call_end',call_id:d.call_id});return}   // caller already gave up
      call.id=d.call_id;setStatus('Ringing…');return;
    }
    if(d.type==='call_accepted'){
      if(!call||call.id!==d.call_id)return;
      setStatus('Connecting…');call.pc=makePC();
      const o=await call.pc.createOffer();await call.pc.setLocalDescription(o);sendSig({sdp:call.pc.localDescription});return;
    }
    if(d.type==='call_signal')return onSignal(d);
    if(d.type==='call_ended'&&call&&call.id===d.call_id)return finish(endMsg(d.reason,call));
    if(d.type==='call_failed'&&call&&call.role==='caller'&&!call.id){
      const n=call.peer.name,m={offline:n+' is offline',busy:'Line busy: someone is already in a call',blocked:'You cannot call this user',not_friends:'You can only call friends'}[d.reason]||'Call failed';
      return finish(m);
    }
  }catch(e){console.error('call error',e);if(call)endCall('Call failed')}
}
const endMsg=(r,c)=>({rejected:c.peer.name+' declined the call',missed:c.role==='caller'?'No answer':'Missed call from '+c.peer.name,cancelled:c.role==='callee'?'Missed call from '+c.peer.name:'Call cancelled',disconnected:'Call ended: connection lost'}[r]||'Call ended');
function onSocketClosed(){if(call)finish('Connection lost')}

/* ---- controls ---- */
function toggleMute(){
  if(!call||!call.local)return;call.muted=!call.muted;
  call.local.getAudioTracks().forEach(t=>t.enabled=!call.muted);
  $c('btnMute').textContent=call.muted?'🔇':'🎤';$c('btnMute').classList.toggle('off',call.muted);
}
function toggleCam(){
  if(!call||call.type!=='video')return;call.camOff=!call.camOff;
  call.local.getVideoTracks().forEach(t=>t.enabled=!call.camOff);
  $c('btnCam').textContent=call.camOff?'🚫':'📷';$c('btnCam').classList.toggle('off',call.camOff);
}
async function flipCam(){                      // front <-> rear camera (phones/tablets)
  if(!call||call.type!=='video')return;
  const f=call.facing==='user'?'environment':'user',old=call.local.getVideoTracks()[0];
  try{
    old.stop();                                // many phones can only open one camera at a time
    const nt=(await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:f}}})).getVideoTracks()[0];
    nt.enabled=!call.camOff;
    const sender=call.pc&&call.pc.getSenders().find(s=>s.track===old);if(sender)await sender.replaceTrack(nt);
    call.local.removeTrack(old);call.local.addTrack(nt);call.facing=f;
    $c('localVid').srcObject=call.local;$c('localVid').classList.toggle('rear',f==='environment');
  }catch(e){toast('Could not switch camera')}
}
function endCall(msg){
  if(!call)return;
  if(call.id)wsSend({type:'call_end',call_id:call.id});
  finish(msg||'Call ended');
}

/* ---- cleanup ---- */
function teardown(){
  ring(false);clearInterval(callTick);callTick=null;
  if(call){clearTimeout(call.connTimer);stopStream(call.local);if(call.pc){call.pc.onconnectionstatechange=null;call.pc.close()}}
  $c('remoteVid').srcObject=null;$c('localVid').srcObject=null;$c('incoming').hidden=true;call=null;
}
function finish(msg){
  const had=call;if(!had)return;
  const dur=had.startedAt?Date.now()-had.startedAt:0;
  teardown();
  if(!$c('call').hidden)showEnded(msg+(dur?' · '+fmt(dur):''));else toast(msg);
}
window.addEventListener('beforeunload',()=>{if(call&&call.id&&ws&&ws.readyState===1)wsSend({type:'call_end',call_id:call.id})});

/* ---- call history rows for the Settings window ---- */
function callRows(list){
  if(!list.length)return '<small class="sub">No calls yet</small>';
  return list.map(c=>`<div class="row" style="padding:2px 0;cursor:default"><span class="grow">${c.outgoing?'↗':'↙'} ${esc(c.peer)} · ${c.call_type==='video'?'🎥':'📞'}<small>${esc(c.status)}${c.duration?' · '+fmt(c.duration*1000):''} · ${new Date(c.started).toLocaleString([],{dateStyle:'short',timeStyle:'short'})}</small></span></div>`).join('');
}
