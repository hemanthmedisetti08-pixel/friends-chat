/* ===== Navigation: browser Back and Android Back behave like a normal app =====
   Every screen has a URL such as #/chat/5, #/settings/privacy, #/profile/7, #/group/5/add.
   Opening a screen PUSHES a history entry; Back (browser, phone or the ← buttons) goes to the previous screen. */
const NAV={i:0,stack:[],ignore:false};
const routeNow=()=>(location.hash||'#/').slice(1)||'/';
function navPush(r){if(r===routeNow())return;NAV.i++;NAV.stack.length=NAV.i;NAV.stack[NAV.i]=r;history.pushState({i:NAV.i},'','#'+r);applyRoute(r)}
function navReplace(r){NAV.stack[NAV.i]=r;history.replaceState({i:NAV.i},'','#'+r);applyRoute(r)}
function parentRoute(r=routeNow()){   // where "Back" goes when there is no earlier history entry
  const p=r.split('/').filter(Boolean);
  if(p[0]==='settings')return p.length>2?'/settings/'+p[1]:p.length===2&&!desktop()?'/settings':(active?'/chat/'+active:'/');
  if(p[0]==='group'&&p.length>2)return '/group/'+p[1];
  if(p[0]==='group'||p[0]==='profile')return active?'/chat/'+active:'/';
  return '/';
}
function navBack(fallback){if(NAV.i>0)history.back();else navReplace(fallback||parentRoute())}
const goChat=id=>NAV.stack[NAV.i-1]==='/chat/'+id?navBack():navPush('/chat/'+id);

/* the screens: the router only shows/hides views; each view keeps its own state (open chat, messages...) */
const showChat=openChat,hidePane=()=>{active=null;document.body.classList.remove('chat-open');$('#pane').hidden=true;$('#empty').hidden=false;renderList()};
openChat=function(id){const r='/chat/'+id;if(routeNow()===r)return showChat(id);desktop()&&routeNow().startsWith('/chat/')?navReplace(r):navPush(r)};
closeChat=function(){navBack('/')};
function applyRoute(r){
  const p=r.split('/').filter(Boolean);
  try{
    if(p[0]==='settings'){hidePage();showSettings(p.slice(1).join(':'));return}
    hideSettings();
    if(p[0]==='profile'){showProfile(+p[1]);return}
    if(p[0]==='group'){showGroup(+p[1],p[2]);return}
    hidePage();
    if(p[0]==='chat'){
      const c=chats.find(c=>c.id===+p[1]);
      if(!c){navReplace('/');return}              // chat was deleted / left: go to the main page
      if(active!==c.id||$('#pane').hidden)showChat(c.id);else document.body.classList.add('chat-open');
      return;
    }
    hidePane();
  }catch(e){console.error(e);if(r!=='/')navReplace('/')}
}
addEventListener('popstate',e=>{
  const was=NAV.i;NAV.i=(e.state&&e.state.i)||0;
  if(NAV.ignore){NAV.ignore=false;return}
  if(typeof me==='undefined'||!me)return;                      // not logged in: nothing to route
  const inCall=(typeof call!=='undefined'&&call&&!$('#call').hidden)||(typeof GC!=='undefined'&&GC.room);
  if(inCall){NAV.ignore=true;history.go(was-NAV.i);toast('Use End call to leave the call');return}   // Back never drops a live call
  if(!$('#modal').hidden){closeModal();NAV.ignore=true;history.go(was-NAV.i);return}                   // Back closes a pop-up first
  applyRoute(routeNow());
});
function navBoot(){   // called once after login: opens the screen named in the URL
  const r=routeNow(),st=history.state;NAV.i=(st&&st.i)||0;
  if(r==='/'){history.replaceState({i:NAV.i},'','#/');NAV.stack[NAV.i]='/';applyRoute('/');return}
  if(st){NAV.stack[NAV.i]=r;applyRoute(r);return}               // page reload: keep the history as it is
  history.replaceState({i:0},'','#/');NAV.i=0;NAV.stack=['/'];  // opened from a link: build the stack so Back climbs one level at a time
  const chain=[];let x=r;while(x!=='/'&&chain.length<4){chain.unshift(x);x=parentRoute(x)}
  chain.forEach(y=>{NAV.i++;NAV.stack[NAV.i]=y;history.pushState({i:NAV.i},'','#'+y)});
  applyRoute(r);
}
/* thin loading bar at the top while the server is working */
let _ld=0;
function loading(d){_ld=Math.max(0,_ld+d);let b=document.getElementById('loadbar');if(!b){b=document.createElement('div');b.id='loadbar';b.setAttribute('role','progressbar');b.setAttribute('aria-label','Loading');document.body.append(b)}b.classList.toggle('on',_ld>0)}
