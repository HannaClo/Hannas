
// ---------------- INSTÄLLNINGAR ----------------
const LEVEL_DURATION = Infinity; // oändlig tid: nivåer byts bara manuellt (N)
const LEVEL_COUNT = 5;
const FADE_SECS = 2;           // nedtoning till svart när världen är klar
const HOLD_SECS = 1;           // sekunder i mörker innan återställningen
const IDLE_RESET_SECS = 30;    // ingen hand/mus på så här länge = nedtoning + återställning (0 = av)
const GRABS_PER_LEVEL = 2;     // antal grepp (grepp + släpp) per nivå innan nästa nivå tar över
const MIN_GRAB_SECS = 0.4;     // ett grepp måste hållas så här länge för att räknas
const NEXT_LEVEL_DELAY_SECS = 4; // sekunder från att kulan lämnade handen (andra släppet) tills nästa nivå tar över
const BALL_RADIUS = 50;
const SLOPE_START_X = 55;
const SLOPE_START_Y_RATIO = 0.30;
const SLOPE_END_Y_RATIO = 0.82;
const GRAVITY_ALONG_SLOPE = 230;
const MAX_POINTER_SPEED = 1500;

// ---------------- UTSEENDE (påverkar inte fysiken) ----------------
const BACKGROUND_IMAGE = "bakgrund.jpg";  // t.ex. "bakgrund.jpg". Tom = inbyggd industrihall
const BG_DIM = 0.0;           // 0-1: gör bakgrundsbilden mörkare
const BG_FLOOR_Y = null;      // t.ex. 0.88 = banans fötter står på 88 % av höjden
const BG_KEEP_LIGHTS = false; // true = behåll strålkastare/dimma/lasrar över bilden
const BALL_ENV_GAIN = 1.8;    // hur starkt bakgrunden speglas i kulan
const BALL_BRIGHTNESS = 1.0;  // kulans ljusstyrka (högre = ljusare metall)
const BALL_STUDIO = 1.0;      // vita studioreflexer (softbox, ljusremsa)
const BALL_NEON = 0.6;        // hur mycket neonljus som speglas i kulan
const MOTION_BLUR = 1.0;      // rörelseoskärpa på kulan (0 = av)
const TRAIL_STRENGTH = 1.0;   // ljussvansens styrka (0 = av)
const STAGE_FX = true;        // rök vid banans fötter + nivåstyrda strålkastare (S växlar medan det körs)
const SMOKE = 1.7;            // rökmängd (0 = ingen, 2 = tjockt)
const SMOKE_AMBIENT = 0.35;   // hur synlig röken är utan ljus (0 = syns bara i strålarna)
const SMOKE_OPACITY = 0.6;    // 1 = som tidigare, lägre = mer genomskinlig rök
const ADAPTIVE_QUALITY = true; // sänker rök och oskärpa automatiskt om bildfrekvensen faller
const SMOKE_MAX = 320;        // max antal rökpuffar samtidigt (sänk om det hackar)
const STAGE_BEAMS = 1.5;      // strålkastarnas styrka (0 = av)
const RAVE_STROBE = 1.0;      // blixt på taktslagen i nivå 5 (0 = av)

const LEVELS = {
  1: {gravity:230, damping:0.10, rollingResistance:0,},
  2: {gravity:230, damping:0.55, rollingResistance:205,},
  3: {gravity:230, damping:0.12, rollingResistance:0,},
  4: {gravity:230, damping:0.32, rollingResistance:0,},
  5: {omega:2.7, zeta:0.16,}
};

// ---------------- TILLSTÅND ----------------
let mode="demo", started=false, level=1, levelStartedAt=0;
let ball={x:55,y:0,vx:0,vy:0,held:false,holdOffsetX:0,holdOffsetY:0,
  previousPointerX:0,previousPointerY:0,releaseSpeed:0,releaseTime:0,
  level4Phase:0,brakeHits:[false,false,false],sleeping:false};
let slope={x1:55,y1:0,x2:0,y2:0};
let lastFrameTime=0, sens=1;

// H(s) = X(s)/A(s) = 1/[s(s+lambda)]
// x' = v, v' = a - lambda*v. lambda är viskös dämpning.
class RollingTransferFunction {
  constructor(){this.position=0;this.velocity=0;}
  reset(position,velocity=0){this.position=position;this.velocity=velocity;}
  update(acceleration,damping,dt){
    const h=Math.min(dt,1/30);
    this.velocity+=(acceleration-damping*this.velocity)*h;
    this.position+=this.velocity*h;
    return this.position;
  }
}

// H(s) = omega^2/[s^2 + 2*zeta*omega*s + omega^2]
// q' = v, v' = omega²(target-q) - 2*zeta*omega*v.
// zeta < 1 ger en avklingande svängning.
class OscillatorTransferFunction {
  constructor(omega,zeta){this.omega=omega;this.zeta=zeta;this.position=0;this.velocity=0;}
  reset(position,velocity=0){this.position=position;this.velocity=velocity;}
  update(target,dt){
    const h=Math.min(dt,1/60);
    const a=this.omega*this.omega*(target-this.position)-
      2*this.zeta*this.omega*this.velocity;
    this.velocity+=a*h; this.position+=this.velocity*h;
    return this.position;
  }
}
const rollingTF=new RollingTransferFunction();
let oscillatorTF=null;

// ---------------- HANDTRACKING (ml5 handpose) ----------------

// Kräver ml5 (0.12.x) i index.html. Knyt handen = greppa kulan, öppna handen = släpp.
let video=null, handPose=null, hands=[], handTrackingReady=false;
let wasPinching=false, handTargetX=null, handVelocity=0, lastHandPredictionTime=0;
let grabBlockedUntil = 0;
let fistFrames=0, openFrames=0, lostHandFrames=0;
let lastHudUpdate=0;
const perf={ms:16.7,q:1};   // q = kvalitet 0.3-1 (styrs av bildfrekvensen)

function setupHandTracking(){
  if(typeof ml5==="undefined"||!ml5.handPose){
    console.error("ml5 1.x (ml5.handPose) kunde inte laddas - kontrollera scriptet i index.html.");
    return;
  }
  video=createCapture(VIDEO);
  video.size(640,480);
  video.hide();
  // MediaPipe-baserad modell (snabbare än gamla handpose). "lite" = snabbast.
  handPose=ml5.handPose({maxHands:1,modelType:"lite",flipped:false},function(){
    console.log("HandPose-modellen är redo!");
    handTrackingReady=true;
    handPose.detectStart(video,gotPose);
  });
}

// Visar i HUD:en var handtrackingen eventuellt fastnar.
function handStatus(){
 // if(!video) return "kameran har inte startat";
  if(wasPinching) return "Greppar kulan";
  if(!hands||hands.length===0) return "Ingen hand syns";
  return "Knyt näven för att greppa kulan";
}

function isFist(landmarks){
  // Kontrollera ENDAST pekfingret.
  // 5 = pekfingrets basled
  // 6 = mellanled
  // 8 = fingertopp

  const wrist = landmarks[0];
  const indexBase = landmarks[5];
  const indexTip = landmarks[8];

  // Pekfingret räknas som böjt när fingertoppen
  // är närmare handleden än basleden.
  return dist(
    indexTip[0], indexTip[1],
    wrist[0], wrist[1]
  ) < dist(
    indexBase[0], indexBase[1],
    wrist[0], wrist[1]
  );
}

function gotPose(results){
  hands=results;
  if(fadeAt!==null) return;   // ingen ny hand tas emot medan världen tonas ut
  if(results&&results.length>0) markActive();

  // Förlorad hand hanteras bara när en ny kamerabild kommer.
  if(!results||results.length===0){
    lostHandFrames++;
    if(wasPinching&&lostHandFrames>=8) releaseHandBall();
    return;
  }
  lostHandFrames=0;

  const kp=results[0].keypoints;
  const landmarks=kp?kp.map(k=>[k.x,k.y]):null;
  if(!landmarks||landmarks.length<21) return;

  const now=millis();
  const fistClosed=isFist(landmarks);
  if(fistClosed){ fistFrames++; openFrames=0; }
  else { openFrames++; fistFrames=0; }

  const palm=landmarks[9];
  const rawX=map(palm[0],0,(video.elt&&video.elt.videoWidth)||video.width,width,0);
  const safeX=constrain(rawX,slope.x1+BALL_RADIUS,width-BALL_RADIUS);

  // Starta greppet efter tre avläsningar med knuten hand.
  if(!wasPinching && fistFrames>=3 && performance.now()>=grabBlockedUntil){
    wasPinching=true; noteGrabStart();
    handTargetX=safeX; handVelocity=0; lastHandPredictionTime=now;
    ball.x=safeX; ball.y=slopeY(ball.x)-BALL_RADIUS;
    ball.vx=0; ball.vy=0; ball.held=true; ball.sleeping=false;
  }

  // Uppdatera handens position en gång per ny kamerabild.
  if(wasPinching&&fistClosed){
    const dt=Math.max(0.02,Math.min(0.15,(now-lastHandPredictionTime)/1000));
    const previousTarget=handTargetX;
    handTargetX=lerp(handTargetX,safeX,0.65);              // lätt lågpass mot skakningar
    const rawVelocity=(handTargetX-previousTarget)/dt;
    handVelocity=lerp(handVelocity,constrain(rawVelocity,-500,500),0.40);
    lastHandPredictionTime=now;
  }

  // Släpp efter fyra avläsningar med öppen hand.
  if(wasPinching&&openFrames>=4) releaseHandBall();
}

function updateHandControl(){
  if(!started||!wasPinching||handTargetX===null) return;
  // Tidsbaserad följning: oberoende av bildfrekvens, och förutsäger handen mellan kamerabilderna.
  const hdt=Math.min(0.05,Math.max(0.001,deltaTime/1000));
  const since=Math.min(0.12,(millis()-lastHandPredictionTime)/1000);
  const aim=constrain(handTargetX+handVelocity*since,slope.x1+BALL_RADIUS,width-BALL_RADIUS);
  ball.x+=(aim-ball.x)*(1-Math.exp(-hdt*16));
  ball.y=slopeY(ball.x)-BALL_RADIUS;
  ball.vx=handVelocity; ball.vy=0;
  ball.held=true; ball.sleeping=false;
}

function releaseHandBall(){
  grabBlockedUntil = performance.now() + 2000;
  noteRelease(); 
   snd("drop",0.7+Math.min(0.3,Math.abs(handVelocity)/1500));
  ball.held=false;
  ball.releaseSpeed=handVelocity;
  ball.vx=handVelocity;
  ball.releaseTime=millis()/1000;
  rollingTF.reset(ball.x,ball.vx);
  if(oscillatorTF) oscillatorTF.reset(ball.x,ball.vx);
  if(mode==="user"&&level===4) ball.level4Phase=1;
  wasPinching=false; handTargetX=null; handVelocity=0; lastHandPredictionTime=0;
  fistFrames=0; openFrames=0;
}

// ---------------- BAKGRUNDSBILD ----------------
// Sätt BACKGROUND_IMAGE högst upp, eller prova dig fram medan det körs:
//   B = välj bild från datorn,  V = tillbaka till inbyggd hall,
//   eller dra och släpp en bild på fönstret.
let bgImg=null, bgNote="", ballEnv=null;

function loadBackground(src){
  const im=new Image();
  im.onload=()=>{ bgImg=im; bgNote="bakgrund.jpg"; buildScene(); updateHud(); };
  im.src=src;
}

function paintBackgroundImage(g,W,H){
  const s=Math.max(W/bgImg.width,H/bgImg.height), w=bgImg.width*s, h=bgImg.height*s;
  g.imageSmoothingQuality="high";
  g.drawImage(bgImg,(W-w)/2,(H-h)/2,w,h);
  if(BG_DIM>0){ g.fillStyle=`rgba(0,0,0,${BG_DIM})`; g.fillRect(0,0,W,H); }
}

let bgPicker=null;
function initBackground(){
  bgPicker=document.createElement("input");
  bgPicker.type="file"; bgPicker.accept="image/*"; bgPicker.style.display="none";
  document.body.appendChild(bgPicker);
  bgPicker.onchange=()=>{
    if(bgPicker.files[0]) loadBackground(URL.createObjectURL(bgPicker.files[0]));
    bgPicker.value="";
  };
  window.addEventListener("dragover",e=>e.preventDefault());
  window.addEventListener("drop",e=>{
    e.preventDefault();
    const f=[...e.dataTransfer.files].find(f=>f.type.startsWith("image/"));
    if(f) loadBackground(URL.createObjectURL(f));
  });
  if(BACKGROUND_IMAGE) loadBackground(BACKGROUND_IMAGE);
}

// ---------------- START, NEDTONING OCH ÅTERSTÄLLNING (som Vattenvärlden) ----------------
let fadeAt=null, lastAct=performance.now();
const musicLevel=()=>mode==="demo"?3:level;
// Ljudet får aldrig kunna stoppa världen: fel i ljudet loggas bara.
const snd=(fn,...a)=>{ try{ if(typeof Ljud!=="undefined"&&Ljud[fn]) return Ljud[fn](...a); }catch(e){ console.warn("Ljud:",fn,e); } };
const fadeEl=()=>document.getElementById("fade");
function markActive(){ lastAct=performance.now(); }

// Tona ned till svart, håll, återställ till nivå 1.
function requestReset(){ if(fadeAt===null&&started) fadeAt=performance.now(); }
function updateFade(){
  if(fadeAt===null) return;
  const e=(performance.now()-fadeAt)/1000;
  if(e>=FADE_SECS+HOLD_SECS){
    fadeAt=null; resetWorld();
    fadeEl().style.opacity=0;
    snd("reset"); snd("fadeIn",1.6);        // musiken börjar om på nivå 1 och tonas upp igen
    return;
  }
  const fa=Math.min(1,e/FADE_SECS);
  fadeEl().style.opacity=fa;
  snd("setFade",fa);                         // ljudet tonas ut med skärmen
}
// ---- Greppräkning: två grepp per nivå, sedan nästa nivå (efter nivå 5: nedtoning + återställning) ----
let grabCount=0, grabStartedAt=0, advanceArmedAt=null;
function clearGrabs(){ grabCount=0; advanceArmedAt=null; }
function noteGrabStart(){ grabStartedAt=performance.now(); }
function noteRelease(){
  if(!started||mode!=="user"||fadeAt!==null) return;
  if(performance.now()-grabStartedAt<MIN_GRAB_SECS*1000) return;   // för kort = räknas inte
  grabCount++; markActive();
  if(grabCount>=GRABS_PER_LEVEL) advanceArmedAt=performance.now();   // räkna sekunder från att kulan lämnade handen
}
// Efter sista släppet: vänta NEXT_LEVEL_DELAY_SECS, byt sedan nivå (oavsett om kulan stannat).
function updateGrabProgress(){
  if(advanceArmedAt===null||fadeAt!==null) return;
  if(ball.held||wasPinching){ advanceArmedAt=null; return; }   // greppad igen: tiden startar om vid nästa släpp
  if(performance.now()-advanceArmedAt>=NEXT_LEVEL_DELAY_SECS*1000) advanceLevel();
}
function advanceLevel(){
  clearGrabs();
  if(level>=LEVEL_COUNT) requestReset();   // alla nivåer genomgångna: tona ut och börja om
  else setLevel(level+1);
}
// Tillbaka till början: användarläge, nivå 1, kulan överst på backen.
function resetWorld(){
  mode="user"; level=1; levelStartedAt=millis()/1000; clearGrabs();
  fx.sparks.length=0; fx.trail.length=0;
  resetBall(); markActive(); updateHud(); updateInfo();
}
// Inaktivitet: bara om något hunnit ändras (annars blir det en evig loop).
function checkIdle(){
  if(!IDLE_RESET_SECS||mode!=="user"||fadeAt!==null) return;
  if(ball.held||wasPinching){ markActive(); return; }
  const moved=level>1||ball.x>slope.x1+BALL_RADIUS+20;
  if(moved&&performance.now()-lastAct>IDLE_RESET_SECS*1000) requestReset();
}
// Startknappen: starta i användarläge och tona upp världen under startsidan.
function startWorld(){
  mode="user"; resetWorld();
  started=true; levelStartedAt=millis()/1000; lastFrameTime=millis()/1000;
  document.body.classList.remove("intro");
  snd("start",millis()/1000,musicLevel());   // startknappen är användargesten som låser upp ljudet
  const st=document.getElementById("start");
  st.classList.add("leaving"); setTimeout(()=>st.remove(),1000);
  updateHud();
}

// ---------------- SETUP / GEOMETRI ----------------
function setup(){
  createCanvas(windowWidth,windowHeight); pixelDensity(1);
  setupHandTracking();
  calculateSlope(); buildScene(); resetBall(); updateHud(); updateInfo();
  initBackground();
  document.getElementById("go").onclick=startWorld;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  calculateSlope();
  buildScene();
}

function calculateSlope() {
  // Backen börjar uppe till vänster.
  slope.x1 = width * 0.02;
  slope.y1 = height * 0.16;

  // Här planar backen ut och övergår till en rak väg.
  slope.x2 = width * 0.76;
  slope.y2 = height * 0.81;
}

function slopeY(x) {
  // Beräkna hur långt kulan har kommit längs backen.
  const t = constrain(
    (x - slope.x1) / (slope.x2 - slope.x1),
    0,
    1
  );

  // Mjuk kurva som gradvis planar ut.
  const curve = 1 - Math.pow(1 - t, 3);

  // Efter backen fortsätter vägen vågrätt.
  return lerp(slope.y1, slope.y2, curve);
}

function resetBall(){
  // Kulan börjar längst upp på vägen.
  ball.x = slope.x1 + BALL_RADIUS + 3;
  ball.y = slopeY(ball.x) - BALL_RADIUS;

  // Nollställ hastigheten så att kulan inte börjar röra sig bakåt.
  ball.vx = 0;
  ball.vy = 0;

  ball.held = false;
  ball.releaseSpeed = 0;
  ball.releaseTime = 0;
  ball.level4Phase = 0;
  ball.brakeHits = [false, false, false];
  ball.sleeping = false;

  // Nivå 2 får en liten starthastighet nedför.
  // Då märks friktionen genom att kulan bromsas.
  if(mode === "user" && level === 2){
    ball.vx = 240;
  }

  rollingTF.reset(ball.x, ball.vx);

  oscillatorTF = new OscillatorTransferFunction(
    LEVELS[5].omega,
    LEVELS[5].zeta
  );

  oscillatorTF.reset(ball.x, 0);

  wasPinching = false;
  handTargetX = null;
  handVelocity = 0;
  lastHandPredictionTime = 0;
  fistFrames = 0;
  openFrames = 0;
  lostHandFrames = 0;

}


// ---------------- LÄGE / NIVÅSYSTEM ----------------
function setMode(m){
  if(mode===m)return; mode=m; level=1; levelStartedAt=millis()/1000; clearGrabs();
  resetBall(); updateHud(); updateInfo();
}
function setLevel(n){
  // Kulan behåller position och rörelse när nivån byts.
  const savedX=ball.x, savedY=ball.y, savedVx=ball.vx, savedVy=ball.vy, wasHeld=ball.held;

  level=constrain(n,1,LEVEL_COUNT); levelStartedAt=millis()/1000; clearGrabs();

  ball.x=savedX; ball.y=savedY; ball.vx=savedVx; ball.vy=savedVy;
  ball.held=wasHeld; ball.sleeping=false;

  // Nollställ bara nivåspecifika saker.
  ball.brakeHits=[false,false,false];
  ball.level4Phase=0;

  rollingTF.reset(ball.x,ball.vx);
  oscillatorTF=new OscillatorTransferFunction(LEVELS[5].omega,LEVELS[5].zeta);
  oscillatorTF.reset(ball.x,ball.vx);

  updateHud(); updateInfo();
}
function updateLevelDirector(now){
  if(mode!=="user"||!started)return;
  if(fadeAt!==null)return;
  if(now-levelStartedAt>=LEVEL_DURATION){
    advanceLevel();
  }
}


// ---------------- FYSIK ----------------
function updateBall(dt,now){

  if(ball.held||!started)return;
  const minX=slope.x1+BALL_RADIUS, maxX=width-BALL_RADIUS;

  const angle = Math.atan2(
    slopeY(ball.x + 2) - slopeY(ball.x - 2),
    4
  );
  // Demo och nivå 1 använder samma rullmodell.
  if(mode === "demo" || level === 1){

    // Tyngdkraftens komponent längs backen.
    const g = GRAVITY_ALONG_SLOPE * Math.sin(angle) * 3;

    // Hindrar kulan från att få en hastighet uppför backen.
    ball.vx = Math.max(0, ball.vx);

    // Uppdatera överföringsfunktionen.
    rollingTF.reset(ball.x, ball.vx);
    rollingTF.update(g, 0.10, dt);

    // Kulan får bara röra sig nedför.
    ball.x = rollingTF.position;
    ball.vx = Math.max(0, rollingTF.velocity);

  } else if(level===2){
    const p=LEVELS[2], g=p.gravity*Math.sin(angle)*3;
    const net=g-p.rollingResistance*Math.sin(angle)*3;
    rollingTF.reset(ball.x,ball.vx);
    rollingTF.update(net,p.damping,dt);
    ball.x=rollingTF.position; ball.vx=rollingTF.velocity;
    if(Math.abs(ball.vx)<2&&net<=0){ball.vx=0;ball.sleeping=true;}
  } else if(level===3){
    const p=LEVELS[3], g=p.gravity*Math.sin(angle)*3;
    const zones=[.30,.56,.78].map(t=>lerp(minX,maxX,t));
    let damping=p.damping, brake=0;
    zones.forEach((z,i)=>{
      if(Math.abs(ball.x-z)<42)damping=5.5;
      if(ball.x>z+55)ball.brakeHits[i]=true;
      if(!ball.brakeHits[i]&&Math.abs(ball.x-z)<20)brake=115;
    });
    rollingTF.reset(ball.x,ball.vx);
    rollingTF.update(g-brake,damping,dt);
    ball.x=rollingTF.position; ball.vx=rollingTF.velocity;
  } else if(level===4){
    const p=LEVELS[4], g=p.gravity*Math.sin(angle)*3;
    const t=now-ball.releaseTime; let a=g;
    if(ball.level4Phase===1){a-=900;if(t>.85)ball.level4Phase=2;}
    else if(ball.level4Phase===2){a+=260;if(t>1.35)ball.level4Phase=3;}
    else if(ball.level4Phase===3){
      a+=(width*.52-ball.x)*.9;
      if(Math.abs(ball.vx)<3&&t>2.5){ball.vx=0;ball.sleeping=true;}
    }
    rollingTF.reset(ball.x,ball.vx); rollingTF.update(a,p.damping,dt);
    ball.x=rollingTF.position; ball.vx=rollingTF.velocity;
  } else if(level===5){
    oscillatorTF.update(width*.52,dt);
    ball.x=oscillatorTF.position; ball.vx=oscillatorTF.velocity;
  }

  if(ball.x<minX){ball.x=minX;if(ball.vx<0){ if(ball.vx<-140)snd("thud",constrain(-ball.vx/900,0.15,1)); ball.vx*=-.25; }}
  if(ball.x>maxX){ball.x=maxX;if(ball.vx>0){ if(ball.vx>140)snd("thud",constrain(ball.vx/900,0.15,1)); ball.vx=0; }}
  ball.y=slopeY(ball.x)-BALL_RADIUS;
  rollingTF.position=ball.x; rollingTF.velocity=ball.vx;
}

// ---------------- RITA: FILMISK RAVE-INDUSTRIMILJÖ ----------------
// Allt nedan är ren presentation. Fysiken ovan läses bara av (ball.x, ball.vx ...)
// och påverkas aldrig av ritkoden.

const PAL = {mag:[255,35,220], cya:[0,235,255], vio:[165,65,255]};
const rgbaStr = (c,a) => `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
const clamp01 = v => v<0 ? 0 : (v>1 ? 1 : v);
const smoothstep01 = (a,b,x) => { const t=clamp01((x-a)/(b-a)); return t*t*(3-2*t); };
const mixCol = (a,b,t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

let roomLayer=null, trackLayer=null, vignetteLayer=null, geo=null;
let floorY=0, sceneScale=1, fogSprites=null, ballTex=null, rig=[];

// Visuellt tillstånd (energi = hur "på" ljuset är, följer kulans fart)
const fx = {
  energy:0, pulse:0, speed:0, prevV:0, decel:0, fric:0, roll:0,
  lift:0, blend:0, phase:0, chase:0, drift:0, sparkAcc:0,
  sparks:[], trail:[], key:""
};

function makeRng(seed){
  let a=seed>>>0;
  return function(){
    a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}
function makeCanvas(w,h){
  const c=document.createElement("canvas");
  c.width=Math.max(1,Math.ceil(w)); c.height=Math.max(1,Math.ceil(h));
  return c;
}
function trussHeight(){ return constrain(height*0.085,56,120); }

// ---------------- BYGG DEN STATISKA SCENEN ----------------
function buildScene(){
  sceneScale = constrain(height/1000,0.6,1.5);
  floorY = Math.min(height-6, Math.max(height*0.9, slope.y2+100*sceneScale));
  if(bgImg && BG_FLOOR_Y) floorY = height*BG_FLOOR_Y;
  buildRoom(); buildBallEnv(); buildTrack(); buildVignette();
  if(!fogSprites) buildFogSprites();
  if(!ballTex) buildBallTexture();
}

function drawSeam(g,x1,y1,x2,y2){
  const ox=(x1===x2)?2:0, oy=(y1===y2)?2:0;
  g.strokeStyle="rgba(0,0,0,.6)"; g.lineWidth=2;
  g.beginPath(); g.moveTo(x1,y1); g.lineTo(x2,y2); g.stroke();
  g.strokeStyle="rgba(170,160,215,.07)"; g.lineWidth=1;
  g.beginPath(); g.moveTo(x1+ox,y1+oy); g.lineTo(x2+ox,y2+oy); g.stroke();
}

function drawColumn(g,cx,y0,y1,sc){
  const cw=58*sc, fl=15*sc, x0=cx-cw/2;
  g.fillStyle="#08090d"; g.fillRect(x0+fl,y0,cw-2*fl,y1-y0);
  for(const f0 of [x0,x0+cw-fl]){
    const fg=g.createLinearGradient(f0,0,f0+fl,0);
    fg.addColorStop(0,"#161922"); fg.addColorStop(.35,"#2d3340");
    fg.addColorStop(.6,"#1b1f28"); fg.addColorStop(1,"#0b0d13");
    g.fillStyle=fg; g.fillRect(f0,y0,fl,y1-y0);
    g.fillStyle="rgba(150,160,195,.22)"; g.fillRect(f0+fl*.32,y0,1,y1-y0);
    // nitar
    for(let y=y0+30*sc;y<y1-20*sc;y+=46*sc){
      g.fillStyle="rgba(0,0,0,.7)"; g.beginPath(); g.arc(f0+fl*.5,y,2.6*sc,0,7); g.fill();
      g.fillStyle="rgba(170,180,215,.25)"; g.beginPath(); g.arc(f0+fl*.5-.6,y-.6,1.2*sc,0,7); g.fill();
    }
  }
  // fotplatta
  const pg=g.createLinearGradient(0,y1-12*sc,0,y1);
  pg.addColorStop(0,"#2a2f3b"); pg.addColorStop(1,"#0c0d12");
  g.fillStyle=pg; g.fillRect(cx-cw*.85,y1-12*sc,cw*1.7,12*sc);
  for(const bx of [-.62,.62]){
    g.fillStyle="rgba(0,0,0,.7)"; g.beginPath(); g.arc(cx+cw*bx,y1-6*sc,3*sc,0,7); g.fill();
  }
}

function buildRoom(){
  const W=width,H=height,sc=sceneScale,tb=trussHeight();
  roomLayer=makeCanvas(W,H);
  const g=roomLayer.getContext("2d"), rnd=makeRng(1337);
  if(bgImg){ paintBackgroundImage(g,W,H); rig=[]; return; }

  // --- Betongvägg ---
  let gr=g.createLinearGradient(0,0,0,floorY);
  gr.addColorStop(0,"#07060d"); gr.addColorStop(.5,"#0f0d18"); gr.addColorStop(1,"#18151f");
  g.fillStyle=gr; g.fillRect(0,0,W,floorY);

  for(let i=0;i<80;i++){
    const x=rnd()*W,y=rnd()*floorY,r=60+rnd()*220,light=rnd()<.5;
    const rg=g.createRadialGradient(x,y,0,x,y,r);
    rg.addColorStop(0,light?"rgba(120,110,150,.07)":"rgba(0,0,0,.22)");
    rg.addColorStop(1,"rgba(0,0,0,0)");
    g.fillStyle=rg; g.fillRect(x-r,y-r,r*2,r*2);
  }
  const n=Math.floor(W*floorY/40);
  for(let i=0;i<n;i++){
    const x=rnd()*W,y=rnd()*floorY;
    g.fillStyle = rnd()<.45
      ? `rgba(190,180,230,${(.02+rnd()*.05).toFixed(3)})`
      : `rgba(0,0,0,${(.06+rnd()*.14).toFixed(3)})`;
    g.fillRect(x,y,rnd()<.15?2:1,1);
  }

  // Gjutskarvar och hål efter formbultar
  const pw=330*sc, ph=230*sc;
  for(let row=0,y=tb;y<floorY;row++,y+=ph){
    drawSeam(g,0,y,W,y);
    const off=(row%2)*pw*.5;
    for(let x=-off;x<W;x+=pw){
      drawSeam(g,x,y,x,Math.min(y+ph,floorY));
      for(const [hx,hy] of [[.22,.28],[.78,.28],[.22,.72],[.78,.72]]){
        const px=x+pw*hx,py=y+ph*hy; if(py>floorY-14) continue;
        g.fillStyle="rgba(0,0,0,.6)"; g.beginPath(); g.arc(px,py,3.6*sc,0,7); g.fill();
        g.strokeStyle="rgba(170,160,210,.10)"; g.lineWidth=1;
        g.beginPath(); g.arc(px,py,4.6*sc,0,7); g.stroke();
      }
    }
  }
  // Rinnande fuktfläckar från taket
  for(let i=0;i<16;i++){
    const x=rnd()*W,w=8+rnd()*30,len=floorY*(.25+rnd()*.6);
    const sg=g.createLinearGradient(0,tb,0,tb+len);
    sg.addColorStop(0,"rgba(0,0,0,.30)"); sg.addColorStop(1,"rgba(0,0,0,0)");
    g.fillStyle=sg; g.fillRect(x,tb,w,len);
  }

  // --- Industriport ---
  const dx0=W*.60,dx1=W*.80,dTop=tb+(floorY-tb)*.30;
  g.fillStyle="#08080d"; g.fillRect(dx0-10*sc,dTop-26*sc,dx1-dx0+20*sc,floorY-dTop+26*sc);
  const sl=11*sc;
  for(let y=dTop;y<floorY;y+=sl){
    const sg=g.createLinearGradient(0,y,0,y+sl);
    sg.addColorStop(0,"#1b1c26"); sg.addColorStop(.15,"#232532");
    sg.addColorStop(.7,"#0d0e14"); sg.addColorStop(1,"#050507");
    g.fillStyle=sg; g.fillRect(dx0,y,dx1-dx0,sl-1);
  }
  const hg=g.createLinearGradient(0,dTop-26*sc,0,dTop);
  hg.addColorStop(0,"#262a35"); hg.addColorStop(1,"#0a0b10");
  g.fillStyle=hg; g.fillRect(dx0-10*sc,dTop-26*sc,dx1-dx0+20*sc,26*sc);

  // --- Stålpelare ---
  for(const f of [.045,.50,.955]) drawColumn(g,W*f,tb,floorY,sc);

  // --- Rör ---
  for(const py of [tb+H*.075, tb+H*.075+24*sc]){
    const pg=g.createLinearGradient(0,py-9*sc,0,py+9*sc);
    pg.addColorStop(0,"#0b0c11"); pg.addColorStop(.3,"#3a4050");
    pg.addColorStop(.5,"#232733"); pg.addColorStop(1,"#07080b");
    g.fillStyle=pg; g.fillRect(0,py-9*sc,W,18*sc);
    for(let x=140*sc;x<W;x+=260*sc){
      g.fillStyle="#12141b"; g.fillRect(x,py-13*sc,10*sc,26*sc);
      g.fillStyle="rgba(150,160,195,.18)"; g.fillRect(x,py-13*sc,10*sc,1);
    }
  }

  // --- Golv (blankpolerad betong) ---
  gr=g.createLinearGradient(0,floorY,0,H);
  gr.addColorStop(0,"#110f1b"); gr.addColorStop(1,"#030207");
  g.fillStyle=gr; g.fillRect(0,floorY,W,H-floorY);
  g.save(); g.beginPath(); g.rect(0,floorY,W,H-floorY); g.clip();
  g.strokeStyle="rgba(190,180,240,.05)"; g.lineWidth=1;
  const vpx=W/2, vpy=floorY-(H-floorY)*3.2;
  for(let k=-16;k<=16;k++){
    const bx=vpx+k*W*.07, t=(floorY-vpy)/(H-vpy), sx=vpx+(bx-vpx)*t;
    g.beginPath(); g.moveTo(sx,floorY); g.lineTo(bx,H); g.stroke();
  }
  for(let j=1;j<=6;j++){
    const y=floorY+(H-floorY)*Math.pow(j/6,1.7);
    g.beginPath(); g.moveTo(0,y); g.lineTo(W,y); g.stroke();
  }
  const sheen=g.createLinearGradient(0,floorY,0,floorY+(H-floorY)*.6);
  sheen.addColorStop(0,"rgba(120,100,200,.10)"); sheen.addColorStop(1,"rgba(120,100,200,0)");
  g.fillStyle=sheen; g.fillRect(0,floorY,W,H-floorY);
  for(let i=0;i<W*(H-floorY)/90;i++){
    g.fillStyle=`rgba(200,190,255,${(.02+rnd()*.04).toFixed(3)})`;
    g.fillRect(rnd()*W,floorY+rnd()*(H-floorY),1,1);
  }
  g.restore();
  // Golvlist
  g.fillStyle="#0a090f"; g.fillRect(0,floorY-12*sc,W,12*sc);
  g.fillStyle="rgba(150,140,200,.25)"; g.fillRect(0,floorY-12*sc,W,1);
  g.fillStyle="rgba(0,0,0,.7)"; g.fillRect(0,floorY,W,2);

  // --- Fackverk i taket ---
  g.fillStyle="#08080d"; g.fillRect(0,0,W,tb);
  const stp=70*sc;
  for(let x=-stp;x<W+stp;x+=stp){
    g.strokeStyle="#1d212b"; g.lineWidth=4*sc;
    g.beginPath(); g.moveTo(x,10*sc); g.lineTo(x+stp/2,tb-10*sc); g.lineTo(x+stp,10*sc); g.stroke();
    g.strokeStyle="rgba(130,140,175,.22)"; g.lineWidth=1;
    g.beginPath(); g.moveTo(x-1,10*sc); g.lineTo(x+stp/2-1,tb-10*sc); g.lineTo(x+stp-1,10*sc); g.stroke();
  }
  for(const cy of [0,tb-12*sc]){
    const cg=g.createLinearGradient(0,cy,0,cy+12*sc);
    cg.addColorStop(0,"#2d3240"); cg.addColorStop(.4,"#171a23"); cg.addColorStop(1,"#09090e");
    g.fillStyle=cg; g.fillRect(0,cy,W,12*sc);
  }

  // --- Strålkastare (huset ritas här, ljuset ritas dynamiskt) ---
  const cols=[PAL.mag,PAL.cya,PAL.vio,PAL.mag,PAL.cya,PAL.vio,PAL.mag,PAL.cya,PAL.vio,PAL.mag];
  const rx=[.06,.16,.27,.38,.49,.60,.71,.82,.92,.98];
  rig=rx.map((fr,i)=>({
    x:W*fr, y:tb+20*sc, col:cols[i],
    base:(i-2.5)*0.075, spread:0.045+0.012*(i%3), phase:i*1.3
  }));
  for(const f of rig){
    g.fillStyle="#12141b"; g.fillRect(f.x-3*sc,tb-2*sc,6*sc,10*sc);
    const cg=g.createLinearGradient(f.x-17*sc,0,f.x+17*sc,0);
    cg.addColorStop(0,"#0a0b10"); cg.addColorStop(.35,"#2c313e"); cg.addColorStop(1,"#08090d");
    g.fillStyle=cg; g.fillRect(f.x-17*sc,tb+4*sc,34*sc,24*sc);
    g.fillStyle="#050508"; g.fillRect(f.x-13*sc,tb+24*sc,26*sc,5*sc);
  }

  // Mörkare uppåt
  const tg=g.createLinearGradient(0,0,0,floorY*.35);
  tg.addColorStop(0,"rgba(0,0,0,.45)"); tg.addColorStop(1,"rgba(0,0,0,0)");
  g.fillStyle=tg; g.fillRect(0,0,W,floorY*.35);
}

// ---------------- BANAN (samma geometri som slopeY) ----------------
function sampleStops(stops,f){
  for(let i=1;i<stops.length;i++){
    if(f<=stops[i][0]){
      const a=stops[i-1],b=stops[i],t=(f-a[0])/Math.max(1e-6,b[0]-a[0]);
      return `rgb(${(a[1][0]+(b[1][0]-a[1][0])*t)|0},${(a[1][1]+(b[1][1]-a[1][1])*t)|0},${(a[1][2]+(b[1][2]-a[1][2])*t)|0})`;
    }
  }
  const l=stops[stops.length-1][1]; return `rgb(${l[0]},${l[1]},${l[2]})`;
}

function buildTrack(){
  const W=width,H=height,sc=sceneScale;
  trackLayer=makeCanvas(W,H);
  const g=trackLayer.getContext("2d"), rnd=makeRng(4242);
  const d=15*sc, T=46*sc, rail=18*sc;
  const xs=[],ys=[];
  for(let x=0;x<W;x+=6){xs.push(x);ys.push(slopeY(x));}
  xs.push(W); ys.push(slopeY(W));
  const N=xs.length;

  const trace=(off,i0=0,i1=N-1)=>{
    g.beginPath(); g.moveTo(xs[i0],ys[i0]+off);
    for(let i=i0+1;i<=i1;i++) g.lineTo(xs[i],ys[i]+off);
  };
  const bandPath=(c,o0,o1)=>{
    c.beginPath(); c.moveTo(xs[0],ys[0]+o0);
    for(let i=1;i<N;i++) c.lineTo(xs[i],ys[i]+o0);
    for(let i=N-1;i>=0;i--) c.lineTo(xs[i],ys[i]+o1);
    c.closePath();
  };
  const shadeBand=(o0,o1,stops,stepPx)=>{
    g.lineCap="butt"; g.lineJoin="round";
    for(let o=o0;o<o1;o+=stepPx){
      g.strokeStyle=sampleStops(stops,(o-o0)/(o1-o0));
      g.lineWidth=stepPx+0.8;
      trace(o+stepPx/2); g.stroke();
    }
  };

  // Skugga på golv och vägg
  const fg=g.createLinearGradient(0,floorY-4,0,floorY+34*sc);
  fg.addColorStop(0,"rgba(0,0,0,.65)"); fg.addColorStop(1,"rgba(0,0,0,0)");
  g.fillStyle=fg; g.fillRect(0,floorY-4,W,38*sc);

  // Stödben (gallerkonstruktion)
  const legs=[.07,.25,.43,.60,.76,.90,.985], gap=44*sc, lw=14*sc;
  for(const lf of legs){
    const cx=W*lf, xl=cx-gap/2, xr=cx+gap/2;
    const tl=slopeY(xl)+d+T*.5, tr=slopeY(xr)+d+T*.5;
    // diagonalstag
    const st=Math.max(tl,tr)+6, step=110*sc;
    g.strokeStyle="#161921"; g.lineWidth=4*sc;
    for(let yy=st;yy+step<floorY-10;yy+=step){
      g.beginPath(); g.moveTo(xl,yy); g.lineTo(xr,yy+step);
      g.moveTo(xr,yy); g.lineTo(xl,yy+step);
      g.moveTo(xl,yy); g.lineTo(xr,yy); g.stroke();
    }
    g.strokeStyle="rgba(150,160,195,.16)"; g.lineWidth=1;
    for(let yy=st;yy+step<floorY-10;yy+=step){
      g.beginPath(); g.moveTo(xl-1,yy); g.lineTo(xr-1,yy+step);
      g.moveTo(xr-1,yy); g.lineTo(xl-1,yy+step); g.stroke();
    }
    for(const [px,top] of [[xl,tl],[xr,tr]]){
      const pg=g.createLinearGradient(px-lw/2,0,px+lw/2,0);
      pg.addColorStop(0,"#12151c"); pg.addColorStop(.35,"#323847");
      pg.addColorStop(.65,"#1b1f29"); pg.addColorStop(1,"#08090d");
      g.fillStyle=pg; g.fillRect(px-lw/2,top,lw,floorY-top);
      g.fillStyle="rgba(150,160,195,.22)"; g.fillRect(px-lw/2+lw*.3,top,1,floorY-top);
    }
    const bg=g.createLinearGradient(0,floorY-10*sc,0,floorY);
    bg.addColorStop(0,"#2a2f3b"); bg.addColorStop(1,"#0b0c11");
    g.fillStyle=bg; g.fillRect(cx-gap*.8,floorY-10*sc,gap*1.6,10*sc);
  }

  // Släpskugga från banan på bakväggen
  g.save();
  g.shadowColor="rgba(0,0,0,.8)"; g.shadowBlur=40*sc; g.shadowOffsetY=26*sc;
  g.fillStyle="#000"; bandPath(g,d,d+T); g.fill();
  g.restore();

  // Bakre skyddsräcke
  bandPath(g,-d-rail,-d); g.fillStyle="#1a1d26"; g.fill();
  shadeBand(-d-rail,-d,[[0,[120,128,150]],[.12,[46,50,62]],[1,[20,22,30]]],1.5);

  // Körytan (borstat stål)
  bandPath(g,-d,d); g.fillStyle="#3a3e4c"; g.fill();
  shadeBand(-d,d,[[0,[62,68,84]],[.5,[100,108,130]],[1,[50,54,68]]],1.5);

  // Frontpanel (mörk industriell metall)
  bandPath(g,d,d+T); g.fillStyle="#22252f"; g.fill();
  shadeBand(d,d+T,[[0,[150,160,185]],[.07,[56,61,75]],[.5,[31,34,44]],[.9,[18,19,26]],[1,[8,8,12]]],2);

  // Borstade repor längs hela banan
  const streak=(off0,off1,count)=>{
    for(let i=0;i<count;i++){
      const off=off0+rnd()*(off1-off0);
      const a=Math.floor(rnd()*(N-8)), b=Math.min(N-1,a+4+Math.floor(rnd()*40));
      g.strokeStyle = rnd()<.6
        ? `rgba(255,255,255,${(.02+rnd()*.05).toFixed(3)})`
        : `rgba(0,0,0,${(.08+rnd()*.12).toFixed(3)})`;
      g.lineWidth=1; trace(off,a,b); g.stroke();
    }
  };
  streak(-d,d,160); streak(d+2,d+T-2,200); streak(-d-rail,-d,50);

  // Skarvar och nitar på frontpanelen
  const seamStep=180*sc;
  for(let x=seamStep;x<W;x+=seamStep){
    const y=slopeY(x);
    g.strokeStyle="rgba(0,0,0,.6)"; g.lineWidth=2;
    g.beginPath(); g.moveTo(x,y+d); g.lineTo(x,y+d+T); g.stroke();
    g.strokeStyle="rgba(170,180,215,.10)"; g.lineWidth=1;
    g.beginPath(); g.moveTo(x+2,y+d); g.lineTo(x+2,y+d+T); g.stroke();
  }
  for(let x=24*sc;x<W;x+=44*sc){
    const y=slopeY(x)+d+T*.62;
    g.fillStyle="rgba(0,0,0,.75)"; g.beginPath(); g.arc(x,y,3*sc,0,7); g.fill();
    g.fillStyle="rgba(180,190,225,.40)"; g.beginPath(); g.arc(x-.7,y-.8,1.3*sc,0,7); g.fill();
  }

  // Kantlister och uttag för neon
  g.strokeStyle="rgba(205,215,240,.55)"; g.lineWidth=1; trace(d); g.stroke();
  g.strokeStyle="rgba(0,0,0,.9)"; g.lineWidth=6*sc; trace(d+7*sc); g.stroke();
  g.strokeStyle="rgba(0,0,0,.9)"; g.lineWidth=5*sc; trace(-d-rail+3*sc); g.stroke();
  g.strokeStyle="rgba(205,215,240,.35)"; g.lineWidth=1; trace(-d-rail); g.stroke();
  g.strokeStyle="rgba(0,0,0,.8)"; g.lineWidth=2; trace(d+T); g.stroke();

  const body=new Path2D();
  body.moveTo(xs[0],ys[0]-d-rail);
  for(let i=1;i<N;i++) body.lineTo(xs[i],ys[i]-d-rail);
  for(let i=N-1;i>=0;i--) body.lineTo(xs[i],ys[i]+d+T);
  body.closePath();
  geo={xs,ys,N,d,T,rail,neonFront:d+7*sc,neonBack:-d-rail+3*sc,body};
}

function buildVignette(){
  const W=width,H=height;
  vignetteLayer=makeCanvas(W,H);
  const g=vignetteLayer.getContext("2d");
  const r=Math.hypot(W,H)/2;
  const vg=g.createRadialGradient(W/2,H*.55,r*.30,W/2,H*.55,r*1.02);
  vg.addColorStop(0,"rgba(0,0,0,0)"); vg.addColorStop(.6,"rgba(0,0,0,.20)");
  vg.addColorStop(1,bgImg?"rgba(0,0,0,.40)":"rgba(0,0,0,.75)");
  g.fillStyle=vg; g.fillRect(0,0,W,H);
}

function buildFogSprites(){
  fogSprites=[PAL.mag,PAL.cya,PAL.vio].map(col=>{
    const c=makeCanvas(256,256),g=c.getContext("2d");
    const rg=g.createRadialGradient(128,128,0,128,128,128);
    rg.addColorStop(0,rgbaStr(col,.50)); rg.addColorStop(.45,rgbaStr(col,.17));
    rg.addColorStop(1,rgbaStr(col,0));
    g.fillStyle=rg; g.fillRect(0,0,256,256);
    return c;
  });
}

// ---------------- METALLKULAN (kromad silverkula, miljöreflektion per pixel) ----------------
// Allt som bara beror på kulans form räknas ut EN gång här. Varje bildruta
// läggs bara de rörliga delarna (miljöbild, neon, lasrar) ovanpå.
function buildBallTexture(){
  const R=BALL_RADIUS, S=Math.ceil(R*2+6), N=S*S, cx=(S-1)/2;
  const cv=makeCanvas(S,S), ctx=cv.getContext("2d"), img=ctx.createImageData(S,S);
  const F=()=>new Float32Array(N);
  const t={S,N,cv,ctx,img,al:F(),nx:F(),ny:F(),rx:F(),up:F(),
    fres:F(),f4:F(),sky:F(),skyG:F(),key:F(),strip:F(),hot:F(),ao:F(),side:F(),fl:F(),
    gm:F(),gc:F(),gv:F(),gl:[F(),F(),F(),F()]};
  // mjuk rektangel i reflektionsrymden (ger den klassiska softbox-reflexen)
  const box=(v,c,h,s)=>smoothstep01(h+s,h-s,Math.abs(v-c));
  const lampX=[-.72,-.26,.24,.70];

  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const i=y*S+x, dx=(x-cx)/R, dy=(y-cx)/R, d=Math.sqrt(dx*dx+dy*dy);
    const a=clamp01((1-d)*R+.5);
    t.al[i]=a; if(a<=0) continue;
    const k=d>1?1/d:1, nx=dx*k, ny=dy*k, nz=Math.sqrt(Math.max(0,1-nx*nx-ny*ny));
    t.nx[i]=nx; t.ny[i]=ny;
    // Reflektionsvektor (kameran tittar längs -z), up = uppåt i rummet
    const rx=2*nz*nx, ry=2*nz*ny, rz=2*nz*nz-1, up=-ry;
    t.rx[i]=rx; t.up[i]=up;

    // Fresnel för silver: hög grundreflektion, ännu starkare mot kanten
    const f=1-nz, f2=f*f;
    t.fres[i]=0.88+0.12*f2*f2*f; t.f4[i]=f2*f2;

    // Studiomiljö: ljus himmel, mörk mark och en tunn horisontglimt
    let sky = up>=0 ? 0.42+0.70*smoothstep01(0,0.95,up)
                    : 0.17+0.14*smoothstep01(-1,-0.1,up);
    sky+=0.55*Math.exp(-(up*up)/0.0016);
    t.sky[i]=sky; t.skyG[i]=smoothstep01(-0.3,0.8,up);

    // Softbox uppe till vänster, ljusremsa till höger, het kärna i softboxen
    t.key[i]=box(rx,-0.50,0.26,0.07)*box(up,0.58,0.20,0.07);
    t.strip[i]=box(rx,0.66,0.05,0.035)*box(up,0.15,0.55,0.12);
    t.hot[i]=Math.exp(-((rx+0.50)*(rx+0.50)+(up-0.62)*(up-0.62))/0.0035);

    // Mjuk ocklusion nedtill (kulan sitter nära banan)
    t.ao[i]=1-0.18*smoothstep01(0.15,1,ny);
    t.side[i]=smoothstep01(-0.3,0.3,nx);

    // Neonkällor: magenta (höger), cyan (vänster), violett motljus
    t.gm[i]=Math.exp((rx*0.881+up*0.275+rz*0.385-1)*20);
    t.gc[i]=Math.exp((-rx*0.870-up*0.127+rz*0.477-1)*16);
    t.gv[i]=Math.exp((rx*0.10+up*0.35-rz*0.93-1)*10);
    // Takets strålkastare
    if(up>0.25){
      const dyy=(up-0.62)/0.085;
      for(let j=0;j<4;j++){const dxx=(rx-lampX[j])/0.15; t.gl[j][i]=Math.exp(-(dxx*dxx+dyy*dyy));}
    }
    // Banans neon underifrån
    if(up<-0.1) t.fl[i]=smoothstep01(-0.1,-0.85,up);
  }
  const rnd=makeRng(99), sca=[],ssa=[],so=[],sl=[];
  for(let k=0;k<7;k++){
    const a=rnd()*Math.PI;
    sca.push(Math.cos(a)); ssa.push(Math.sin(a));
    so.push((rnd()-.5)*1.3); sl.push(.25+rnd()*.5);
  }
  Object.assign(t,{sca,ssa,so,sl});
  ballTex=t;
}

// Miljön som kulan speglar = den färdiga bakgrunden (egen bild eller inbyggd hall)
function buildBallEnv(){
  ballEnv=null;
  try{
    const ew=192, eh=Math.max(8,Math.round(ew*height/width));
    const c=makeCanvas(ew,eh), g=c.getContext("2d",{willReadFrequently:true});
    g.drawImage(roomLayer,0,0,ew,eh);
    const px=g.getImageData(0,0,ew,eh).data, out=new Float32Array(ew*eh*3);
    for(let i=0,j=0;i<px.length;i+=4,j+=3){
      out[j]=(px[i]/255)**2; out[j+1]=(px[i+1]/255)**2; out[j+2]=(px[i+2]/255)**2;
    }
    ballEnv={w:ew,h:eh,d:out};
  }catch(e){
    // Webbläsaren blockerar pixelläsning av en bild som öppnats direkt från disk.
    if(bgImg) bgNote="";
  }
}

function renderBallTexture(roll,pos){
  const t=ballTex, d=t.img.data, N=t.N, env=ballEnv;
  const en=fx.energy, pu=fx.pulse, ph=fx.phase;
  const cr=Math.cos(roll), sr=Math.sin(roll);
  const neon=BALL_NEON*(bgImg?0.45:1);
  const inten=0.38+0.62*en;
  const lampC=[PAL.mag,PAL.cya,PAL.vio,PAL.mag].map(c=>[c[0]/255,c[1]/255,c[2]/255]);
  const lampI=[0,1,2,3].map(j=>(inten*(0.55+0.45*Math.sin(ph*2.1+j*1.7))+pu*0.8)*neon);
  const aL=ph*.8, cl=Math.cos(aL), sl=Math.sin(aL), oL=.12*Math.sin(ph*1.3);
  const aL2=-ph*.55+1.2, cl2=Math.cos(aL2), sl2=Math.sin(aL2), oL2=.15*Math.cos(ph*.9);
  const laserI=(0.15+0.85*en)*neon;
  const floorI=(0.30+0.9*en+pu*0.5)*neon*0.65;
  const magI=(1.15*inten+pu*0.9)*neon, cyaI=(1.0*inten+pu*0.6)*neon, vioI=0.6*inten*neon;
  const edgeI=(0.12+en*0.55)*neon;
  const wob=0.18*Math.sin(ph*1.1);
  const studio=BALL_STUDIO*(0.8+0.2*inten);
  const skyW=env?0.35:1, envG=BALL_ENV_GAIN;
  const uOff=(pos.x/width-0.5)*0.30;
  const ew=env?env.w:0, eh=env?env.h:0;

  for(let i=0;i<N;i++){
    const al=t.al[i];
    if(al<=0){ d[i*4+3]=0; continue; }
    const rx=t.rx[i], up=t.up[i];

    // 1) himmel/mark + (om finns) bakgrundsbildens reflektion
    const sk=t.sky[i]*skyW, g1=t.skyG[i];
    let r=sk*(0.74+0.26*g1), g=sk*(0.75+0.25*g1), b=sk*(0.80+0.20*g1);
    if(env){
      let u=0.5+rx*0.48+uOff, v=0.5-up*0.48;
      u-=Math.floor(u*0.5)*2; if(u>1) u=2-u;
      v=v<0?0:(v>1?1:v);
      const fxp=u*(ew-1), fyp=v*(eh-1), x0=fxp|0, y0=fyp|0;
      const x1=x0+1<ew?x0+1:x0, y1=y0+1<eh?y0+1:y0, tx=fxp-x0, ty=fyp-y0;
      const a00=(y0*ew+x0)*3, a10=(y0*ew+x1)*3, a01=(y1*ew+x0)*3, a11=(y1*ew+x1)*3, E=env.d;
      const w00=(1-tx)*(1-ty), w10=tx*(1-ty), w01=(1-tx)*ty, w11=tx*ty;
      r+=(E[a00]*w00+E[a10]*w10+E[a01]*w01+E[a11]*w11)*envG;
      g+=(E[a00+1]*w00+E[a10+1]*w10+E[a01+1]*w01+E[a11+1]*w11)*envG;
      b+=(E[a00+2]*w00+E[a10+2]*w10+E[a01+2]*w01+E[a11+2]*w11)*envG;
    }

    // 2) vita studioreflexer (softbox, ljusremsa, het kärna)
    const ke=(t.key[i]*2.6+t.hot[i]*2.4)*studio, se=t.strip[i]*1.8*studio;
    r+=ke*0.99+se*0.92; g+=ke+se*0.96; b+=ke+se;

    // 3) neon: strålkastare, färgade ljuskällor, banans glöd, lasrar
    for(let j=0;j<4;j++){
      const e=t.gl[j][i]*lampI[j]*1.3, c=lampC[j];
      r+=e*c[0]; g+=e*c[1]; b+=e*c[2];
    }
    const em=t.gm[i]*magI; r+=em; g+=em*0.16; b+=em*0.84;
    const ec=t.gc[i]*cyaI; r+=ec*0.10; g+=ec*0.90; b+=ec;
    const ev=t.gv[i]*vioI; r+=ev*0.59; g+=ev*0.29; b+=ev;
    if(up<-0.1){
      const m=clamp01(0.5+rx*0.7+wob), e=t.fl[i]*floorI;
      r+=e*((PAL.cya[0]*(1-m)+PAL.mag[0]*m)/255);
      g+=e*((PAL.cya[1]*(1-m)+PAL.mag[1]*m)/255);
      b+=e*((PAL.cya[2]*(1-m)+PAL.mag[2]*m)/255);
    }
    const p1=rx*cl+up*sl-oL, l1=Math.exp(-p1*p1/0.0009)*laserI*0.7;
    const p2=rx*cl2+up*sl2-oL2, l2=Math.exp(-p2*p2/0.0009)*laserI*0.7;
    r+=l1*0.10+l2; g+=l1*0.90+l2*0.15; b+=l1+l2*0.85;
    const f4=t.f4[i]*edgeI, sd=t.side[i];
    r+=f4*(0.15+0.80*sd); g+=f4*(0.80-0.55*sd); b+=f4*(1.0-0.15*sd);

    // 4) metallens egen färg + Fresnel + ocklusion (kall silvertoning)
    const k=t.fres[i]*t.ao[i];
    r*=k*0.97; g*=k*0.985; b*=k;

    // 5) mikroskopiska slipmärken (roterar med kulan, mycket diskreta)
    const sx=t.nx[i]*cr+t.ny[i]*sr, sy=-t.nx[i]*sr+t.ny[i]*cr;
    let scr=0;
    for(let q=0;q<7;q++){
      const dd=sx*t.sca[q]+sy*t.ssa[q]-t.so[q];
      if(dd<0.012&&dd>-0.012){
        const al2=-sx*t.ssa[q]+sy*t.sca[q];
        if(al2>-t.sl[q]&&al2<t.sl[q]) scr+=(1-Math.abs(dd)/0.012)*0.5;
      }
    }
    const lum0=(r+g+b)/3, add=scr*(0.02+lum0*0.18);
    r+=add; g+=add; b+=add;

    // 6) filmisk tonkomprimering + vitglödgning av starka reflexer
    const lum=(r+g+b)/3, w=smoothstep01(0.9,2.2,lum)*0.85;
    const ex=1.5*BALL_BRIGHTNESS;
    r=1-Math.exp(-r*ex); g=1-Math.exp(-g*ex); b=1-Math.exp(-b*ex);
    r+=(1-r)*w; g+=(1-g)*w; b+=(1-b)*w;

    d[i*4]=r*255; d[i*4+1]=g*255; d[i*4+2]=b*255; d[i*4+3]=al*255;
  }
  t.ctx.putImageData(t.img,0,0);
}

// ---------------- VISUELLT TILLSTÅND FRÅN FYSIKEN ----------------
function updateFx(dt,now){
  const th=Math.atan2(slopeY(ball.x+2)-slopeY(ball.x-2),4);
  const sp = ball.held ? Math.min(Math.hypot(ball.vx,ball.vy)*0.6,900) : Math.abs(ball.vx);
  fx.speed=sp;

  // Energi: snabb attack när kulan sätter fart, långsam avklingning vid inbromsning
  const target=clamp01(sp/850);
  fx.energy+=(target-fx.energy)*(1-Math.exp(-dt*(target>fx.energy?4.5:1.5)));
  fx.phase+=dt*(0.30+1.2*fx.energy);
  fx.chase+=dt*(30+280*fx.energy);
  fx.drift+=dt*(0.4+0.8*fx.energy);
  fx.pulse=Math.pow(1-((now*128/60)%1),3)*fx.energy;   // 128 BPM, bara när det rör sig

  // Rullning (för slipmärkena på kulan)
  if(!ball.held) fx.roll+=(ball.vx/Math.max(0.35,Math.cos(th)))*dt/BALL_RADIUS;

  // Friktion = verklig inbromsning (+ kända bromszoner)
  const key=mode+":"+level;
  let dec=0;
  if(key===fx.key && !ball.held) dec=Math.min(2500,Math.max(0,(fx.prevV-sp)/Math.max(dt,0.001)));
  fx.key=key; fx.prevV=sp;
  fx.decel+=(dec-fx.decel)*(1-Math.exp(-dt*9));
  let fr=0;
  if(mode==="demo"||level<=3) fr=clamp01(fx.decel/240);
  if(mode==="user"&&level===2) fr=Math.max(fr,0.5*clamp01(sp/200));
  if(mode==="user"&&level===3&&!ball.held){
    const minX=slope.x1+BALL_RADIUS, maxX=width-BALL_RADIUS;
    for(const tt of [.30,.56,.78]){
      if(Math.abs(ball.x-lerp(minX,maxX,tt))<42) fr=Math.max(fr,0.85*clamp01(sp/160));
    }
  }
  fx.fric=ball.held?0:fr;
}

function ballVisualPos(dt){
  const R=BALL_RADIUS;
  fx.lift+=((ball.held?34:0)-fx.lift)*(1-Math.exp(-dt*18));
  fx.blend+=((ball.held?0:1)-fx.blend)*(1-Math.exp(-dt*9));
  const th=Math.atan2(slopeY(ball.x+2)-slopeY(ball.x-2),4);
  const cy=slopeY(ball.x);
  // Mitt på kulan ligger längs banans normal så att den tangerar ytan
  const restX=ball.x+R*Math.sin(th), restY=cy-R*Math.cos(th);
  const hx=ball.x, hy=ball.y-fx.lift;
  return {x:hx+(restX-hx)*fx.blend, y:hy+(restY-hy)*fx.blend, th, cx:ball.x, cy};
}

// ---------------- DYNAMISKA LJUS ----------------
function drawFog(ctx,now,layer){
  const en=fx.energy, W=width;
  ctx.save(); ctx.globalCompositeOperation="lighter";
  for(let i=layer;i<14;i+=2){
    const sp=fogSprites[i%3];
    const x=(((i*0.173)+fx.drift*(0.004+0.0015*(i%5)))%1.3-0.15)*W;
    const y=floorY*(0.30+0.62*((i*0.382)%1))+Math.sin(now*0.25+i)*22;
    const sz=(300+110*(i%4))*sceneScale;
    ctx.globalAlpha=0.05+0.07*en+0.04*fx.pulse;
    ctx.drawImage(sp,x-sz/2,y-sz/2,sz,sz*0.7);
  }
  if(layer===1){
    ctx.globalAlpha=1;
    const hz=ctx.createLinearGradient(0,floorY-height*.18,0,floorY+height*.04);
    hz.addColorStop(0,"rgba(110,60,190,0)");
    hz.addColorStop(.8,`rgba(110,60,190,${(0.05+0.09*en).toFixed(3)})`);
    hz.addColorStop(1,"rgba(110,60,190,0)");
    ctx.fillStyle=hz; ctx.fillRect(0,floorY-height*.18,W,height*.22);
  }
  ctx.restore();
}

function drawBeams(ctx){
  const en=fx.energy, pu=fx.pulse, sc=sceneScale;
  ctx.save(); ctx.globalCompositeOperation="lighter";
  rig.forEach((f,i)=>{
    const sweep=(0.10+0.28*en)*Math.sin(fx.phase*(0.8+0.12*i)+f.phase);
    const ang=f.base+sweep, L=(floorY-f.y)/Math.cos(ang);
    const a=(0.030+0.085*en+0.16*pu)*(0.7+0.3*Math.sin(fx.phase*1.7+i));
    ctx.save(); ctx.translate(f.x,f.y); ctx.rotate(ang);
    [1,0.55,0.28].forEach(m=>{
      const hw=L*Math.tan(f.spread*m);
      const gr=ctx.createLinearGradient(0,0,0,L);
      gr.addColorStop(0,rgbaStr(f.col,a*1.6));
      gr.addColorStop(.6,rgbaStr(f.col,a*.7));
      gr.addColorStop(1,rgbaStr(f.col,a*.25));
      ctx.fillStyle=gr; ctx.beginPath();
      ctx.moveTo(0,0); ctx.lineTo(-hw,L); ctx.lineTo(hw,L); ctx.closePath(); ctx.fill();
    });
    ctx.restore();
    // ljuspöl där strålen träffar golvet
    const hx=f.x-Math.sin(ang)*L, rad=Math.max(40*sc,L*Math.tan(f.spread)*2.2);
    ctx.save(); ctx.translate(hx,floorY); ctx.scale(1,0.16);
    const pg=ctx.createRadialGradient(0,0,0,0,0,rad);
    pg.addColorStop(0,rgbaStr(f.col,0.35*(0.4+en+pu)));
    pg.addColorStop(1,rgbaStr(f.col,0));
    ctx.fillStyle=pg; ctx.beginPath(); ctx.arc(0,0,rad,0,7); ctx.fill();
    ctx.restore();
    // linsen
    const lg=ctx.createRadialGradient(f.x,f.y,0,f.x,f.y,26*sc);
    lg.addColorStop(0,rgbaStr(mixCol(f.col,[255,255,255],.6),0.35+0.5*en+0.4*pu));
    lg.addColorStop(1,rgbaStr(f.col,0));
    ctx.fillStyle=lg; ctx.beginPath(); ctx.arc(f.x,f.y,26*sc,0,7); ctx.fill();
  });
  ctx.restore();
}

function drawLasers(ctx){
  const en=fx.energy; if(en<0.03) return;
  const sc=sceneScale, ty=trussHeight()+8*sc, len=Math.hypot(width,height);
  ctx.save();
  ctx.beginPath(); ctx.rect(0,0,width,floorY); ctx.clip();
  ctx.globalCompositeOperation="lighter"; ctx.lineCap="round";
  [[.2,PAL.cya,1],[.5,PAL.mag,-1],[.8,PAL.cya,1]].forEach(([fr,col,dir],e)=>{
    const ox=width*fr;
    for(let k=0;k<3;k++){
      const ang=dir*(0.15+0.3*Math.sin(fx.phase*0.9+e*2+k*0.6))+(k-1)*0.20;
      const ex=ox+Math.sin(ang)*len, ey=ty+Math.cos(ang)*len;
      const lgr=ctx.createLinearGradient(ox,ty,ex,ey);
      lgr.addColorStop(0,rgbaStr(mixCol(col,[255,255,255],.5),0.55*en));
      lgr.addColorStop(.55,rgbaStr(col,0.22*en)); lgr.addColorStop(1,rgbaStr(col,0));
      ctx.strokeStyle=rgbaStr(col,0.05*en); ctx.lineWidth=5*sc;
      ctx.beginPath(); ctx.moveTo(ox,ty); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.strokeStyle=lgr; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(ox,ty); ctx.lineTo(ex,ey); ctx.stroke();
    }
  });
  ctx.restore();
}

function tracePoly(ctx,off){
  ctx.beginPath(); ctx.moveTo(geo.xs[0],geo.ys[0]+off);
  for(let i=1;i<geo.N;i++) ctx.lineTo(geo.xs[i],geo.ys[i]+off);
}

function drawTrackLight(ctx,pos){
  const en=fx.energy, pu=fx.pulse, sc=sceneScale, W=width;
  // Ljus som glider över metallen
  ctx.save(); ctx.clip(geo.body); ctx.globalCompositeOperation="lighter";
  for(let i=0;i<5;i++){
    const u=((fx.drift*(0.05+0.02*i)+i*0.21)%1.2)-0.1, x=u*W;
    const y=slopeY(x)+geo.d+geo.T*0.35;
    const col=(i%2)?PAL.cya:PAL.mag;
    ctx.save(); ctx.translate(x,y); ctx.scale(3.2,0.5);
    const gr=ctx.createRadialGradient(0,0,0,0,0,60);
    gr.addColorStop(0,rgbaStr(col,0.05+0.18*en+0.2*pu)); gr.addColorStop(1,rgbaStr(col,0));
    ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(0,0,60,0,7); ctx.fill();
    ctx.restore();
  }
  // Kulans neonglöd på banan
  const gc=mixCol(PAL.mag,PAL.cya,0.5+0.5*Math.sin(fx.phase*1.3));
  ctx.save(); ctx.translate(pos.cx,pos.cy); ctx.scale(1,0.45);
  const bg=ctx.createRadialGradient(0,0,0,0,0,150);
  bg.addColorStop(0,rgbaStr(gc,(0.14+0.22*en+0.25*pu)*fx.blend)); bg.addColorStop(1,rgbaStr(gc,0));
  ctx.fillStyle=bg; ctx.beginPath(); ctx.arc(0,0,150,0,7); ctx.fill();
  ctx.restore();
  ctx.restore();

  // Integrerad neonlist: magenta fram, cyan på bakre skyddsräcket
  const glow=0.45+0.35*en+0.35*pu;
  ctx.save(); ctx.globalCompositeOperation="lighter"; ctx.lineJoin="round";
  [[geo.neonFront,PAL.mag],[geo.neonBack,PAL.cya]].forEach(([off,col])=>{
    tracePoly(ctx,off);
    ctx.setLineDash([]);
    ctx.strokeStyle=rgbaStr(col,0.07*glow); ctx.lineWidth=14*sc; ctx.stroke();
    ctx.strokeStyle=rgbaStr(col,0.16*glow); ctx.lineWidth=7*sc; ctx.stroke();
    ctx.strokeStyle=rgbaStr(col,0.90); ctx.lineWidth=2.6*sc; ctx.stroke();
    ctx.strokeStyle=`rgba(255,255,255,${(0.55*glow).toFixed(3)})`; ctx.lineWidth=1; ctx.stroke();
    // springande ljus längs listen
    ctx.setLineDash([70*sc,180*sc]); ctx.lineDashOffset=-fx.chase*(off>0?1:-1);
    ctx.strokeStyle=`rgba(255,255,255,${(0.9*(0.25+0.75*en)).toFixed(3)})`;
    ctx.lineWidth=3.6*sc; ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.restore();
}

function drawFloorLight(ctx,pos){
  const en=fx.energy, pu=fx.pulse, W=width, sc=sceneScale;
  ctx.save(); ctx.globalCompositeOperation="lighter";
  const cols=[PAL.cya,PAL.vio,PAL.mag,PAL.vio,PAL.cya];
  cols.forEach((c,i)=>{
    const x=W*(0.1+i*0.2);
    ctx.save(); ctx.translate(x,floorY+4*sc); ctx.scale(1,0.14);
    const r=W*0.20, gr=ctx.createRadialGradient(0,0,0,0,0,r);
    gr.addColorStop(0,rgbaStr(c,0.05+0.10*en+0.12*pu)); gr.addColorStop(1,rgbaStr(c,0));
    ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(0,0,r,0,7); ctx.fill();
    ctx.restore();
  });
  // Punkt på golvet under kulan följer med den
  const gc=mixCol(PAL.mag,PAL.cya,0.5+0.5*Math.sin(fx.phase*1.3));
  ctx.save(); ctx.translate(pos.cx,floorY+6*sc); ctx.scale(1,0.15);
  const r=190*sc, gr=ctx.createRadialGradient(0,0,0,0,0,r);
  gr.addColorStop(0,rgbaStr(gc,0.10+0.30*en+0.25*pu)); gr.addColorStop(1,rgbaStr(gc,0));
  ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(0,0,r,0,7); ctx.fill();
  ctx.restore();
  ctx.restore();
}

function drawFloorReflection(ctx){
  const W=width, Hf=Math.min(height-floorY,floorY*0.5);
  if(Hf<8) return;
  ctx.save();
  ctx.globalAlpha=0.30;
  ctx.translate(0,floorY*2); ctx.scale(1,-1);
  ctx.drawImage(ctx.canvas,0,floorY-Hf,W,Hf,0,floorY-Hf,W,Hf);
  ctx.restore();
  const fg=ctx.createLinearGradient(0,floorY,0,height);
  fg.addColorStop(0,"rgba(4,3,8,.15)"); fg.addColorStop(1,"rgba(4,3,8,.92)");
  ctx.fillStyle=fg; ctx.fillRect(0,floorY,W,height-floorY);
}

// ---------------- SCEN-FX: RÖK VID FÖTTERNA + NIVÅSTYRDA STRÅLKASTARE ----------------
// Ren presentation: läser bara ball.x/ball.y/mode/level och påverkar aldrig fysiken.
let stageOn = STAGE_FX;

// Mjuk övergång mellan nivåerna (värdena glider mot målet ~1 s).
//  top/floor = antal strålkastare uppifrån / från golvet, speed = svepfart, amp = svepbredd,
//  bright = ljusstyrka, warm = magenta (0) cyan/violett -> (1) magenta, cycle = färgcykling,
//  zones = rikta mot bromszonerna, track = följ kulan, smoke = rökmängd,
//  strobe/laser = rave-effekter, beat = hur hårt ljuset pulserar i 128 BPM
const STAGE_LEVELS = {
  demo:{top:6,floor:4,speed:.45,amp:.18,bright:.85,warm:.3,cycle:.5,zones:0,track:0,smoke:1.4,strobe:0,laser:.3,beat:.35,spread:1},
  1:{top:6,floor:4,speed:.48,amp:.18,bright:.85,warm:.3,cycle:.4,zones:0,track:0,smoke:1.4,strobe:0,laser:.3,beat:.35,spread:1},
  2:{top:7,floor:5,speed:.55,amp:.22,bright:.95,warm:.6,cycle:.5,zones:0,track:.35,smoke:1.6,strobe:0,laser:.4,beat:.5,spread:1},
  3:{top:7,floor:5,speed:.75,amp:.28,bright:1.0,warm:.4,cycle:.8,zones:1,track:0,smoke:1.6,strobe:0,laser:.5,beat:.7,spread:1},
  4:{top:8,floor:6,speed:.85,amp:.32,bright:1.1,warm:.5,cycle:1,zones:0,track:0,smoke:1.8,strobe:.2,laser:.8,beat:.85,spread:1},
  5:{top:8,floor:6,speed:1.35,amp:.42,bright:1.2,warm:.5,cycle:1,zones:0,track:.6,smoke:2.0,strobe:.5,laser:1,beat:1,spread:1}
};
const TOP_X=[.08,.18,.29,.40,.50,.60,.71,.82,.92,.98], ZONE_OF={0:0,2:1,1:2};
const FLOOR_X=[.08,.20,.32,.44,.56,.68,.80,.92];
const LEG_X=[.04,.14,.25,.36,.47,.58,.69,.80,.91,.98];
const stage={v:{...STAGE_LEVELS.demo},phase:0,beat:0,bx:0,by:0,zoneX:[0,0,0],zoneHit:[0,0,0],spots:[]};

function stageColor(i){
  const v=stage.v, cool=(i%2)?PAL.vio:PAL.cya, hot=(i%2)?PAL.vio:PAL.mag;
  let c=mixCol(cool,hot,v.warm);
  if(v.cycle>0.01) c=mixCol(c,mixCol(PAL.mag,PAL.cya,0.5+0.5*Math.sin(stage.phase*0.7+i*1.1)),v.cycle);
  return c;
}

function updateStage(dt,now){
  const t=STAGE_LEVELS[mode==="demo"?"demo":level]||STAGE_LEVELS[1], v=stage.v;
  const k=1-Math.exp(-dt*1.6);
  for(const n in t) v[n]+=(t[n]-v[n])*k;
  stage.phase+=dt*(0.25+1.3*v.speed);
  stage.beat=Math.pow(1-((now*128/60)%1),3);
  if(!stage.bx){stage.bx=ball.x; stage.by=ball.y;}
  const kb=1-Math.exp(-dt*2.5);
  stage.bx+=(ball.x-stage.bx)*kb; stage.by+=(ball.y-stage.by)*kb;
  const minX=slope.x1+BALL_RADIUS, maxX=width-BALL_RADIUS;
  [.30,.56,.78].forEach((tt,j)=>{
    stage.zoneX[j]=lerp(minX,maxX,tt);
    const near=mode==="user"&&level===3&&!ball.held&&Math.abs(ball.x-stage.zoneX[j])<60;
    stage.zoneHit[j]+=((near?1:0)-stage.zoneHit[j])*(1-Math.exp(-dt*8));
  });
  if(!smoke.spr) buildSmokeSprites();
  updateSmoke(dt,now);
}

// ---------------- RÖK (brusbaserad, belyst av strålkastarna) ----------------
const smoke={p:[],acc:0,burst:1,vent:0,spr:null,bank:null};

let noiseGrid=null; const NG=64;
// Fraktalbrus (fBm). per>0 ger bruset periodiskt i x (för sömlösa dimbankar).
function fbm(x,y,per,oct){
  if(!noiseGrid){
    const r=makeRng(555); noiseGrid=new Float32Array(NG*NG);
    for(let i=0;i<NG*NG;i++) noiseGrid[i]=r();
  }
  let s=0,a=0.5,f=1,norm=0;
  for(let k=0;k<oct;k++){
    const px=per>0?Math.min(NG,per*f):NG;
    const X=x*f+k*13, Y=y*f+k*7.7, xi=Math.floor(X), yi=Math.floor(Y);
    const xf=X-xi, yf=Y-yi, u=xf*xf*(3-2*xf), v=yf*yf*(3-2*yf);
    const x0=((xi%px)+px)%px, x1=(x0+1)%px, y0=((yi%NG)+NG)%NG, y1=(y0+1)%NG;
    const n0=noiseGrid[y0*NG+x0]*(1-u)+noiseGrid[y0*NG+x1]*u;
    const n1=noiseGrid[y1*NG+x0]*(1-u)+noiseGrid[y1*NG+x1]*u;
    s+=(n0*(1-v)+n1*v)*a; norm+=a; a*=0.5; f*=2;
  }
  return s/norm;
}

function buildSmokeSprites(){
  // färgvarianter: [0] = neutral dunkel rök, [1..3] = rök upplyst av magenta/cyan/violett
  const tints=[[165,172,190],[255,90,230],[70,225,255],[185,110,255]];
  const paint=(w,h,dens,lit,col,mixw)=>{
    const c=makeCanvas(w,h), g=c.getContext("2d"), img=g.createImageData(w,h), d=img.data;
    for(let i=0;i<w*h;i++){
      const a=dens[i]; if(a<=0) continue;
      const L=lit?lit[i]:1;
      d[i*4]  =(col[0]*(1-mixw)+255*mixw)*L;
      d[i*4+1]=(col[1]*(1-mixw)+255*mixw)*L;
      d[i*4+2]=(col[2]*(1-mixw)+255*mixw)*L;
      d[i*4+3]=a*255;
    }
    g.putImageData(img,0,0); return c;
  };

  // Enskilda rökpuffar (6 former)
  smoke.spr=[];
  const S=160;
  for(let sd=0;sd<6;sd++){
    const dens=new Float32Array(S*S), lit=new Float32Array(S*S), ox=sd*3.7, oy=sd*2.3;
    for(let y=0;y<S;y++) for(let x=0;x<S;x++){
      const u=x/S, v=y/S, dx=(u-.5)*2, dy=(v-.5)*2.2, r=Math.sqrt(dx*dx+dy*dy);
      if(r>=1) continue;
      const wx=fbm(u*2+ox+5,v*2+oy,0,3)-.5, wy=fbm(u*2+ox,v*2+oy+9,0,3)-.5;  // domain warp = krullar
      const px=u*3+wx*1.4+ox, py=v*3+wy*1.4+oy, n=fbm(px,py,0,4);
      dens[y*S+x]=clamp01((n-0.30)*2.2)*smoothstep01(1,0.15,r)*0.85;
      lit[y*S+x]=clamp01(0.8+(fbm(px-0.05,py+0.05,0,4)-n)*6);              // volymskuggning
    }
    smoke.spr.push(tints.map((col,ti)=>paint(S,S,dens,lit,col,ti?0.1:0)));
  }

  // Långa dimbankar som glider längs golvet (sömlösa i x)
  const BW=512, BH=128, dens=new Float32Array(BW*BH);
  for(let y=0;y<BH;y++) for(let x=0;x<BW;x++){
    const u=x/BW, v=y/BH;
    const n=fbm(u*8,v*2.2+3,8,4);
    const prof=smoothstep01(0,.6,v)*(1-smoothstep01(.85,1,v));   // tjockast nere, tunnar ut uppåt
    dens[y*BW+x]=clamp01((n-0.36)*2.4)*prof;
  }
  smoke.bank=tints.map((col,ti)=>paint(BW,BH,dens,null,col,ti?0.1:0));
}

function spawnSmoke(x,burst){
  const sc=sceneScale;
  smoke.p.push({
    x:x+(Math.random()-.5)*50*sc, y:floorY+(Math.random()-.4)*10*sc,
    vx:(Math.random()-.5)*(burst?280:30)*sc,
    vy:-(burst?25+Math.random()*60:3+Math.random()*9)*sc,
    s:(burst?55+Math.random()*45:70+Math.random()*60)*sc,
    life:0, max:7+Math.random()*5, rot:(Math.random()-.5)*0.6, vr:(Math.random()-.5)*0.08,
    sh:(Math.random()*6)|0, a:0.10+Math.random()*0.08, seed:Math.random()*100,
    front:Math.random()<0.3
  });
}

function updateSmoke(dt,now){
  const v=stage.v, W=width, sc=sceneScale, dens=SMOKE*v.smoke, P=smoke.p;
  if(dens>0.02){
    // svag grundström + rökmaskinen som då och då pyser ur en fot
    smoke.acc+=dt*(4+5*dens);
    while(smoke.acc>=1){ smoke.acc-=1; if(P.length>=SMOKE_MAX*perf.q) break;
      spawnSmoke(Math.random()<0.25?Math.random()*W:W*LEG_X[(Math.random()*LEG_X.length)|0],false); }
    smoke.burst-=dt;
    if(smoke.burst<=0){
      smoke.burst=1.0+Math.random()*1.8;
      const vx=W*LEG_X[(Math.random()*LEG_X.length)|0], n=Math.round(6+6*dens);
      for(let i=0;i<n&&P.length<SMOKE_MAX*perf.q;i++) spawnSmoke(vx,true);
    }
  }
  const RX2=Math.pow(260*sc,2), top=floorY-height*0.5;
  for(let i=P.length-1;i>=0;i--){
    const p=P[i]; p.life+=dt;
    if(p.life>p.max){P.splice(i,1);continue;}
    const u=p.life/p.max;
    // turbulens (långsamma virvlar) + varm rök som stiger och kyls av
    p.vx+=(Math.sin(p.y*0.011+now*0.45+p.seed)+0.6*Math.sin(p.x*0.006-now*0.3+p.seed*2.1))*14*sc*dt;
    p.vy+=Math.sin(p.x*0.009+now*0.38+p.seed*1.7)*5*sc*dt-9*sc*(1-u)*dt;
    // starthastigheten från maskinen bromsas hårt i början
    const drag=Math.exp(-dt*(0.4+1.4*(1-clamp01(u*4))));
    p.vx*=drag; p.vy*=Math.exp(-dt*(0.5+0.8*(1-clamp01(u*4))));
    if(p.y<top) p.vy+=(top-p.y)*0.5*dt;                       // mjukt tak
    if(p.y>floorY+16*sc){ p.y=floorY+16*sc; if(p.vy>0) p.vy=0; }
    // kulan skjuter undan röken, drar med den i färdriktningen och lyfter den
    const dx=p.x-ball.x, dy=(p.y-ball.y)*0.5, d2=dx*dx+dy*dy;
    if(d2<RX2&&!ball.held){
      const f=1-d2/RX2;
      p.vx+=ball.vx*1.4*f*dt+dx/(Math.abs(dx)+30)*60*f*dt;
      p.vy-=Math.abs(ball.vx)*0.15*f*dt;
    }
    p.x+=p.vx*dt; p.y+=p.vy*dt; p.rot+=p.vr*dt;
  }
}

function drawSmoke(ctx,layer){
  const v=stage.v, en=fx.energy, dens=SMOKE*v.smoke, spots=stage.spots, sc=sceneScale;
  if(!smoke.spr||(dens<0.02&&!smoke.p.length)) return;
  const T=millis()/1000, bt=stage.beat*v.beat;
  ctx.save(); ctx.globalCompositeOperation="source-over";

  if(layer===0){   // dimbankar längs golvet
    const W=width, Wb=W*1.2, bh=height*0.30;
    const KB=Math.max(1,Math.round(4*perf.q));
    for(let k=0;k<KB;k++){
      const off=((T*(7+4*k)+k*W*0.37)%Wb+Wb)%Wb;
      const y=floorY-bh*(0.62-0.11*k)+Math.sin(T*0.3+k)*6*sc;
      const base=Math.min(1,(0.10+0.04*k)*Math.min(1.5,dens))*SMOKE_OPACITY;
      for(const ox of [-off,-off+Wb]){
        ctx.globalCompositeOperation="source-over"; ctx.globalAlpha=base*SMOKE_AMBIENT*1.6;
        ctx.drawImage(smoke.bank[0],ox,y,Wb,bh);
        ctx.globalCompositeOperation="lighter";
        ctx.globalAlpha=Math.min(1,base*(0.25+0.9*en+0.9*bt)*0.8);
        ctx.drawImage(smoke.bank[1+(k%3)],ox,y,Wb,bh);
      }
    }
    ctx.globalCompositeOperation="source-over";
  }

  const PN=[[1,.14,.86],[0,.92,1],[.65,.25,1]];   // magenta, cyan, violett
  for(const p of smoke.p){
    if((layer===1)!==p.front) continue;
    const u=p.life/p.max, env=smoothstep01(0,0.12,u)*(1-smoothstep01(0.45,1,u));
    const al=p.a*env*clamp01(0.4+dens)*(layer?0.8:1)*SMOKE_OPACITY;
    if(al<0.003) continue;
    const s=p.s*(1+1.5*Math.sqrt(u));

    // hur mycket ljus träffar just den här puffen? (summera närliggande ljuspölar)
    let r=0,g=0,b=0;
    for(const sp of spots){
      const rr=sp.r*2.5+90*sc, dx=(p.x-sp.x)/rr, dy=(p.y-sp.y)/(rr*(sp.flat<.5?1.6:1));
      const w=Math.exp(-(dx*dx+dy*dy)*2)*sp.a;
      r+=sp.col[0]*w; g+=sp.col[1]*w; b+=sp.col[2]*w;
    }
    let lit=(r+g+b)/765*1.4;
    if(!spots.length){   // egen hall utan stage-spots: färga efter position
      const c=stageColor(Math.floor(p.x/width*8)); r=c[0]; g=c[1]; b=c[2];
      lit=0.35*(0.4+en+bt);
    }
    lit=clamp01(lit);
    let ti=0;
    if(lit>0.02){
      const m=Math.max(r,g,b,1), nr=r/m, ng=g/m, nb=b/m; let best=9;
      PN.forEach((c,i)=>{const d=(nr-c[0])**2+(ng-c[1])**2+(nb-c[2])**2; if(d<best){best=d;ti=i;}});
    }

    const set=smoke.spr[p.sh];
    ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot);
    ctx.globalAlpha=Math.min(1,al*3*SMOKE_AMBIENT*1.6);        // mörk rök i omgivningsljus
    ctx.drawImage(set[0],-s/2,-s*0.4,s,s*0.8);
    if(lit>0.02){                                              // belyst rök lyser upp additivt
      ctx.globalCompositeOperation="lighter";
      ctx.globalAlpha=Math.min(1,al*3*lit*1.0);
      ctx.drawImage(set[1+ti],-s/2,-s*0.4,s,s*0.8);
    }
    ctx.restore();
  }
  ctx.restore();
}

function stageBeam(ctx,sx,sy,rot,L,spr,col,a){
  ctx.save(); ctx.translate(sx,sy); ctx.rotate(rot);
  for(const m of [1,.55,.28]){
    const hw=L*Math.tan(spr*m), g=ctx.createLinearGradient(0,0,0,L);
    g.addColorStop(0,rgbaStr(col,a*1.6)); g.addColorStop(.6,rgbaStr(col,a*.7)); g.addColorStop(1,rgbaStr(col,a*.25));
    ctx.fillStyle=g; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-hw,L); ctx.lineTo(hw,L); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// Ritas bakom banan. Ljuspölarna (stage.spots) ritas efteråt av drawStageSpots.
function drawStageBeams(ctx){
  const v=stage.v, sc=sceneScale, en=fx.energy, bt=stage.beat*v.beat, ph=stage.phase;
  const base=STAGE_BEAMS*v.bright*(0.045+0.06*en);
  stage.spots.length=0;
  ctx.save(); ctx.globalCompositeOperation="lighter";
  TOP_X.forEach((fr,i)=>{
    const on=clamp01(v.top-i); if(on<0.01) return;
    const sx=width*fr, sy=0, zi=ZONE_OF[i];
    const ang0=(fr-.5)*.30+v.amp*Math.sin(ph*(0.8+0.12*i)+i*1.3);
    let tx=sx-Math.tan(ang0)*floorY, ty=floorY, hit=0;
    if(zi!==undefined&&v.zones>0.01){            // nivå 3: lås på bromszonerna
      const zx=stage.zoneX[zi]; tx+=(zx-tx)*v.zones; ty+=(slopeY(zx)-ty)*v.zones;
      hit=stage.zoneHit[zi]*v.zones;
    }
    if(v.track>0.01){                            // följ kulan
      const fan=(i-2.5)*60*sc*(0.6+0.4*Math.sin(ph*1.3+i));
      tx+=(stage.bx+fan-tx)*v.track; ty+=(Math.min(floorY,stage.by)-ty)*v.track;
    }
    const L=Math.hypot(tx-sx,ty-sy), spr=(0.027+0.007*(i%3))*v.spread;
    const col=mixCol(stageColor(i),[255,255,255],0.4*hit);
    const a=(base*(0.75+0.25*Math.sin(ph*1.7+i))+STAGE_BEAMS*0.10*bt*v.bright)*on*(1+2.2*hit);
    stageBeam(ctx,sx,sy,Math.atan2(sx-tx,ty-sy),L,spr,col,a);
    stage.spots.push({x:tx,y:ty,col,a:0.35*(0.4+en+bt)*on*v.bright*(1+hit),
      r:Math.max(28*sc,L*Math.tan(spr)*1.7),flat:0.16+0.4*clamp01(v.zones+v.track)});
    stage.spots.push({x:sx,y:0,col,a:0.4*on,r:18*sc,flat:1});   // lampan i kanten
  });
  FLOOR_X.forEach((fr,i)=>{                      // golvlampor som lyser uppåt
    const on=clamp01(v.floor-i); if(on<0.01) return;
    const sx=width*fr, sy=floorY;
    const ang=(fr-.5)*.30+v.amp*1.2*Math.sin(ph*(0.9+0.1*i)+i*2.1+1);
    const col=stageColor(i+1);
    const a=(base*0.9*(0.75+0.25*Math.sin(ph*1.9+i))+STAGE_BEAMS*0.09*bt*v.bright)*on;
    stageBeam(ctx,sx,sy,Math.PI-ang,sy/Math.cos(ang),0.024*v.spread,col,a);
    stage.spots.push({x:sx,y:sy+4*sc,col,a:0.4*(0.5+bt+en)*on*v.bright,r:70*sc,flat:0.25});
  });
  ctx.restore();
}

function drawStageSpots(ctx){
  ctx.save(); ctx.globalCompositeOperation="lighter";
  for(const s of stage.spots){
    ctx.save(); ctx.translate(s.x,s.y); ctx.scale(1,s.flat);
    const g=ctx.createRadialGradient(0,0,0,0,0,s.r);
    g.addColorStop(0,rgbaStr(s.col,s.a)); g.addColorStop(1,rgbaStr(s.col,0));
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,s.r,0,7); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawStageLasers(ctx){
  const la=stage.v.laser; if(la<0.03) return;
  const sc=sceneScale, len=Math.hypot(width,height), ph=stage.phase, bt=1+0.8*stage.beat*stage.v.beat;
  ctx.save(); ctx.beginPath(); ctx.rect(0,0,width,floorY); ctx.clip();
  ctx.globalCompositeOperation="lighter"; ctx.lineCap="round";
  [[.2,PAL.cya,1],[.5,PAL.mag,-1],[.8,PAL.cya,1]].forEach(([fr,col,dir],e)=>{
    const ox=width*fr;
    for(let k=0;k<3;k++){
      const ang=dir*(0.15+0.3*Math.sin(ph*0.9+e*2+k*0.6))+(k-1)*0.20;
      const ex=ox+Math.sin(ang)*len, ey=Math.cos(ang)*len;
      const lg=ctx.createLinearGradient(ox,0,ex,ey);
      lg.addColorStop(0,rgbaStr(mixCol(col,[255,255,255],.5),0.55*la*bt));
      lg.addColorStop(.55,rgbaStr(col,0.22*la*bt)); lg.addColorStop(1,rgbaStr(col,0));
      ctx.strokeStyle=rgbaStr(col,0.05*la); ctx.lineWidth=5*sc;
      ctx.beginPath(); ctx.moveTo(ox,0); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.strokeStyle=lg; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(ox,0); ctx.lineTo(ex,ey); ctx.stroke();
    }
  });
  ctx.restore();
}

// Ett mjukt ljusblixt på varje taktslag (128 BPM ≈ 2,1 blixtar/s, under 3/s). RAVE_STROBE = 0 stänger av.
function drawStrobe(ctx,now){
  const s=stage.v.strobe*RAVE_STROBE; if(s<0.02) return;
  const f=Math.pow(Math.max(0,1-((now*128/60)%1)*5),2);
  if(f<0.01) return;
  ctx.save(); ctx.globalCompositeOperation="lighter";
  ctx.fillStyle=`rgba(225,205,255,${(0.08*s*f).toFixed(4)})`; ctx.fillRect(0,0,width,height);
  ctx.restore();
}

// ---------------- KULA, SPÅR, GNISTOR ----------------
// Svansen består av (1) en mjuk, jämnbred glöd som tonar ut med alpha,
// (2) tunna ljusstrimmor med olika längd och (3) rörelseoskärpa (se drawBallVisual).
function drawTrail(ctx,pos,now){
  const tr=fx.trail;
  if(!ball.held && fx.speed>80) tr.push({x:pos.x,y:pos.y,t:now});
  while(tr.length && (now-tr[0].t>0.42 || tr.length>64)) tr.shift();
  const amt=smoothstep01(160,750,fx.speed)*(ball.held?0:1)*TRAIL_STRENGTH;
  const n=tr.length;
  if(n<5||amt<0.02) return;
  const R=BALL_RADIUS;
  // normal i varje punkt
  const nxs=[],nys=[];
  for(let i=0;i<n;i++){
    const a=tr[Math.max(0,i-1)], b=tr[Math.min(n-1,i+1)];
    let dx=b.x-a.x, dy=b.y-a.y; const len=Math.hypot(dx,dy)||1; dx/=len; dy/=len;
    nxs.push(-dy); nys.push(dx);
  }
  if(!fx.streaks){
    const rnd=makeRng(7); fx.streaks=[];
    for(let k=0;k<11;k++) fx.streaks.push({
      off:((rnd()+rnd())-1)*0.85, len:0.30+rnd()*0.70, w:0.7+rnd()*1.9,
      b:0.35+rnd()*0.65, mix:rnd(), ph:rnd()*6.28
    });
  }
  const pathOffset=(i0,off)=>{
    ctx.beginPath();
    for(let i=i0;i<n;i++){
      const px=tr[i].x+nxs[i]*off, py=tr[i].y+nys[i]*off;
      if(i===i0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
  };
  const grad=(i0,off,stops)=>{
    const p0=tr[i0], p1=tr[n-1];
    const g=ctx.createLinearGradient(p0.x+nxs[i0]*off,p0.y+nys[i0]*off,p1.x+nxs[n-1]*off,p1.y+nys[n-1]*off);
    for(const [s,c] of stops) g.addColorStop(s,c);
    return g;
  };
  ctx.save(); ctx.globalCompositeOperation="lighter"; ctx.lineCap="round"; ctx.lineJoin="round";

  // 1) mjuk glöd: tre lager med avtagande bredd, tonar ut mot svansens slut
  [[1.15,0.06,PAL.vio],[0.70,0.09,PAL.mag],[0.32,0.12,PAL.cya]].forEach(([wf,al,col])=>{
    pathOffset(0,0);
    ctx.strokeStyle=grad(0,0,[[0,rgbaStr(col,0)],[0.55,rgbaStr(col,al*amt*0.6)],[1,rgbaStr(col,al*amt*1.6)]]);
    ctx.lineWidth=R*wf; ctx.stroke();
  });

  // 2) ljusstrimmor: parallella, olika långa och tunna -> ingen skarp triangelspets
  for(const s of fx.streaks){
    const i0=Math.min(n-2,Math.floor(n*(1-s.len)));
    const off=s.off*R*0.80;
    const col=mixCol(PAL.cya,PAL.mag,s.mix);
    const fl=0.8+0.2*Math.sin(now*28+s.ph);
    const a=amt*s.b*fl;
    pathOffset(i0,off);
    ctx.strokeStyle=grad(i0,off,[
      [0,rgbaStr(col,0)],
      [0.45,rgbaStr(col,0.28*a)],
      [1,rgbaStr(mixCol(col,[255,255,255],0.65),0.85*a)]
    ]);
    ctx.lineWidth=s.w*sceneScale; ctx.stroke();
  }
  ctx.restore();
}

function drawContact(ctx,pos){
  const R=BALL_RADIUS, a=fx.blend;
  if(a<0.02) return;
  ctx.save(); ctx.translate(pos.cx,pos.cy); ctx.rotate(pos.th);
  // mjuk skugga
  ctx.save(); ctx.scale(1,0.2);
  let gr=ctx.createRadialGradient(0,0,0,0,0,R*1.15);
  gr.addColorStop(0,`rgba(0,0,0,${(0.80*a).toFixed(3)})`); gr.addColorStop(1,"rgba(0,0,0,0)");
  ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(0,0,R*1.15,0,7); ctx.fill();
  ctx.restore();
  // hård kontaktskugga precis under punkten
  ctx.save(); ctx.scale(1,0.10);
  gr=ctx.createRadialGradient(0,0,0,0,0,R*0.5);
  gr.addColorStop(0,`rgba(0,0,0,${(0.95*a).toFixed(3)})`); gr.addColorStop(1,"rgba(0,0,0,0)");
  ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(0,0,R*0.5,0,7); ctx.fill();
  ctx.restore();
  ctx.restore();
}

function drawSparks(ctx,pos,dt){
  const sp=fx.sparks;
  // Emission: mer vid friktion, bara några få vid hög fart
  if(!ball.held && fx.speed>25){
    const rate=fx.fric*120+clamp01(fx.speed/900)*10*(fx.fric>0.05?1:0.6);
    fx.sparkAcc+=rate*dt;
    while(fx.sparkAcc>=1){
      fx.sparkAcc-=1;
      if(sp.length>260) break;
      const tx=Math.cos(pos.th), ty=Math.sin(pos.th), nx=Math.sin(pos.th), ny=-Math.cos(pos.th);
      const v=Math.abs(ball.vx), s=60+Math.random()*220;
      sp.push({
        x:pos.cx+(Math.random()-.5)*10, y:pos.cy-1,
        vx:tx*v*0.35+nx*s*0.5+(Math.random()-.3)*90,
        vy:ty*v*0.35+ny*s+(Math.random()-.5)*30,
        life:0, max:0.22+Math.random()*0.35,
        col:Math.random()<.5?PAL.mag:PAL.cya
      });
    }
  } else fx.sparkAcc=0;

  ctx.save(); ctx.globalCompositeOperation="lighter"; ctx.lineCap="round";
  // varm glöd vid kontaktpunkten
  if(fx.fric>0.05){
    const gr=ctx.createRadialGradient(pos.cx,pos.cy,0,pos.cx,pos.cy,34);
    gr.addColorStop(0,`rgba(255,220,250,${(0.35*fx.fric).toFixed(3)})`); gr.addColorStop(1,"rgba(255,60,220,0)");
    ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(pos.cx,pos.cy,34,0,7); ctx.fill();
  }
  for(let i=sp.length-1;i>=0;i--){
    const s=sp[i]; s.life+=dt;
    if(s.life>s.max||s.y>floorY){ sp.splice(i,1); continue; }
    s.vy+=900*dt; s.vx*=1-1.2*dt; s.x+=s.vx*dt; s.y+=s.vy*dt;
    const f=1-s.life/s.max;
    ctx.strokeStyle=rgbaStr(mixCol([255,255,255],s.col,1-f),f);
    ctx.lineWidth=0.4+1.6*f;
    ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(s.x-s.vx*0.035,s.y-s.vy*0.035); ctx.stroke();
  }
  ctx.restore();
}

function drawBallVisual(ctx,pos){
  const R=BALL_RADIUS, en=fx.energy, pu=fx.pulse;
  // glorior runt kulan
  ctx.save(); ctx.globalCompositeOperation="lighter";
  const hc=mixCol(PAL.mag,PAL.cya,0.5+0.5*Math.sin(fx.phase*1.3));
  const hg=ctx.createRadialGradient(pos.x,pos.y,R*.9,pos.x,pos.y,R*2.4);
  hg.addColorStop(0,rgbaStr(hc,0.05+0.12*en+0.18*pu)); hg.addColorStop(1,rgbaStr(hc,0));
  ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(pos.x,pos.y,R*2.4,0,7); ctx.fill();
  ctx.restore();

  renderBallTexture(fx.roll,pos);
  const half=ballTex.S/2;

  // Rörelseoskärpa: kulan ritas om några gånger bakåt längs banan med fallande alpha
  const blur=smoothstep01(120,900,Math.abs(ball.vx))*(ball.held?0:1)*fx.blend*MOTION_BLUR;
  if(blur>0.02){
    const steps=Math.max(3,Math.round(12*perf.q)), shutter=0.042;
    ctx.save();
    for(let k=steps;k>=1;k--){
      const q=k/steps, gx=ball.x-ball.vx*shutter*q;
      if(gx<slope.x1) continue;
      const p=restPosAt(gx);
      ctx.globalAlpha=blur*0.26*(1-q*0.85);
      ctx.drawImage(ballTex.cv,p.x-half,p.y-half);
    }
    ctx.restore();
  }
  ctx.drawImage(ballTex.cv,pos.x-half,pos.y-half);

  if(ball.held){
    ctx.save(); ctx.globalCompositeOperation="lighter";
    ctx.strokeStyle="rgba(25,230,255,.18)"; ctx.lineWidth=7;
    ctx.beginPath(); ctx.arc(pos.x,pos.y,R*1.55,0,7); ctx.stroke();
    ctx.strokeStyle="#19e6ff"; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(pos.x,pos.y,R*1.55,0,7); ctx.stroke();
    ctx.restore();
  }
}

// Kulans mittpunkt när den vilar på banan vid x (samma formel som ballVisualPos)
function restPosAt(x){
  const R=BALL_RADIUS, th=Math.atan2(slopeY(x+2)-slopeY(x-2),4), cy=slopeY(x);
  return {x:x+R*Math.sin(th), y:cy-R*Math.cos(th)};
}

// ---------------- HELA SCENEN ----------------
function renderScene(dt,now){
  const ctx=drawingContext;
  if(!roomLayer||!trackLayer||!geo) buildScene();
  updateFx(dt,now);
  if(stageOn) updateStage(dt,now);
  const pos=ballVisualPos(dt);

  ctx.save();
  ctx.globalAlpha=1; ctx.globalCompositeOperation="source-over";
  ctx.drawImage(roomLayer,0,0);
  const lights=!bgImg||BG_KEEP_LIGHTS;
  if(lights){ drawFog(ctx,now,0); drawBeams(ctx); drawLasers(ctx); }
  if(stageOn&&!lights){ drawStageBeams(ctx); drawStageLasers(ctx); }
  ctx.drawImage(trackLayer,0,0);
  drawTrackLight(ctx,pos);
  if(stageOn){ drawStageSpots(ctx); drawSmoke(ctx,0); }
  if(lights){ drawFloorLight(ctx,pos); drawFloorReflection(ctx); }
  drawTrail(ctx,pos,now);
  drawContact(ctx,pos);
  drawBallVisual(ctx,pos);
  drawSparks(ctx,pos,dt);
  if(stageOn) drawSmoke(ctx,1);
  if(lights) drawFog(ctx,now,1);
  if(stageOn) drawStrobe(ctx,now);

  // Svag skärmpuls i takt med musiken + vinjett
  if(fx.pulse>0.02){
    ctx.globalCompositeOperation="lighter";
    ctx.fillStyle=`rgba(255,50,220,${(0.03*fx.pulse).toFixed(4)})`;
    ctx.fillRect(0,0,width,height);
    ctx.globalCompositeOperation="source-over";
  }
  ctx.drawImage(vignetteLayer,0,0);
  ctx.restore();
}

function draw(){
  background("#06040e");
  updateHandControl();
  if(!started)return;
  updateFade(); checkIdle(); updateGrabProgress();
  perf.ms+=(Math.min(100,deltaTime)-perf.ms)*0.05;
  if(ADAPTIVE_QUALITY){
    if(perf.ms>22) perf.q=Math.max(0.3,perf.q-0.01);
    else if(perf.ms<18) perf.q=Math.min(1,perf.q+0.004);
  }
  const now=millis()/1000;
  const dt=Math.min(.033,Math.max(.001,now-lastFrameTime||.016));
  lastFrameTime=now; updateLevelDirector(now); updateBall(dt,now);
  renderScene(dt,now);
  snd("update",{dt,speed:Math.abs(ball.vx),held:ball.held,fric:fx.fric,level:musicLevel()});
  if(now-lastHudUpdate>0.15){ updateHud(); lastHudUpdate=now; }
}

// ---------------- HUD - FÖRLAGANS PLACERING OCH STIL ----------------
function updateHud(){
  const status=mode==="demo"?"DEMO (låst, allt fungerar)":"ANVÄNDARE";
  let extra=mode==="user"?`\nGrepp denna nivå: ${Math.min(grabCount,GRABS_PER_LEVEL)}/${GRABS_PER_LEVEL}`:"";
  const label=mode==="demo"?"DEMO":`NIVÅ ${level}/${LEVEL_COUNT}`;
  const desc=mode==="demo"?"Fri fysik":LEVELS[level].name;
  const controls=mode==="demo"?
    "1 = demoläge\n2 = användarläge\nKnyt handen (eller använd musen) för att greppa kulan":
    "1 = demoläge\n2 = användarläge\nN = nästa nivå manuellt";
  document.getElementById("hud").textContent=
`
${label}
Hand: ${handStatus()}`;
}
function updateInfo(){
    document.getElementById("info").textContent="";
  }

// ---------------- TANGENTBORD ----------------
function keyPressed(){
  markActive();
  if(key==="1")setMode("demo");
  else if(key==="2")setMode("user");
  else if(key==="n"||key==="N"){
    if(mode==="user"){
      markActive();
      advanceLevel();
    }
  } else if(key==="+"||key==="="){sens*=1.25;updateHud();}
  else if(key==="-"){sens/=1.25;updateHud();}
  else if(key==="b"||key==="B"){if(bgPicker)bgPicker.click();}
  else if(key==="v"||key==="V")clearBackground();
  else if(key==="s"||key==="S")stageOn=!stageOn;
  else if(key==="r"||key==="R")requestReset();
  else if(key==="m"||key==="M")snd("toggleMute");
}