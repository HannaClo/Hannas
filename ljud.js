// FYSIK ÄR ETT FÖRSLAG - VÄRLD 5: RÖRELSE - LJUD OCH MUSIK
// Allt ljud syntetiseras i Web Audio (inga ljudfiler behövs).
//  1. Metallkulan släpps/krockar: kompakt metalliskt "klonk" (stålkula mot stålbana) med snabba studsar.
//  2. Kulan rullar: realistiskt rulljud (muller + textur + små ticks) som följer hastigheten.
//  3. Musik: 128 BPM, låst till ljusets puls i kula.js. Lager läggs på nivå för nivå.
// API (anropas från kula.js): Ljud.start, update, drop, thud, setFade, fadeIn, reset, toggleMute

const Ljud = (() => {
  "use strict";

  // ---------------- INSTÄLLNINGAR (skruva här om något är för starkt/svagt) ----------------
  const MASTER_VOL = 0.85;   // totalvolym
  const MUSIC_VOL  = 0.55;   // musiken
  const SFX_VOL    = 0.95;   // kulans ljud (släpp + rullning)
  const ROLL_VOL   = 0.85;   // bara rulljudet
  const REVERB_VOL = 0.5;    // mängd rumsklang
  const KLONK_VOL   = 1.0;   // klonket (släpp + krock)
  const KLONK_PITCH = 1.0;   // tonhöjd på klonket (0.8 = tyngre/mörkare, 1.3 = ljusare)
  const KLONK_RING  = 1.0;   // hur länge metallen klingar (0.5 = torrt "tock", 1.6 = mer ringande)
  const ROLL_PITCH  = 1.0;   // tonhöjd på rulljudet (lägre = tyngre kula)
  const SEAM_VOL    = 0.5;   // små "tock" när kulan passerar skarvar i banan (0 = av)
  const SEAM_PX     = 340;   // ungefärligt avstånd mellan skarvarna, i pixlar
  const BPM = 128;           // samma som ljuspulsen i kula.js
  const STEP = 60 / BPM / 4; // en 16-dels

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  // ---------------- MUSIK: ackord och nivåer ----------------
  // Fyra ackord, två takter var: Am - F - Am - G (a-moll, mörkt och spänt)
  const PROG = [
    { root: 33, pad: [45, 52, 57, 60], arp: [57, 60, 64, 69, 72, 76] },
    { root: 29, pad: [41, 48, 53, 57], arp: [53, 57, 60, 65, 69, 72] },
    { root: 33, pad: [45, 52, 57, 60], arp: [57, 60, 64, 69, 72, 76] },
    { root: 31, pad: [43, 50, 55, 59], arp: [55, 59, 62, 67, 71, 74] }
  ];
  const KICK_STEPS = [0, 4, 8, 12];
  // pad = padnivå, padCut = padfiltrets öppning, air = luftbrus, ping = chans för "ping" per takt,
  // duck = sidechain-pump på pad/bas/arp, kick/bass/clap/arp = lager (null = av)
  const LV = {
    1: { pad: 0.55, padCut: 520,  air: 0.05, ping: 0.55, duck: 0,    kick: null, bass: null, hat: 0, clap: 0, arp: 0 },
    2: { pad: 0.50, padCut: 700,  air: 0.05, ping: 0.45, duck: 0.14, kick: { g: 0.26, lp: 105, click: 0 }, bass: null, hat: 0, clap: 0, arp: 0 },
    3: { pad: 0.44, padCut: 900,  air: 0.04, ping: 0.30, duck: 0.35, kick: { g: 0.75, lp: 0,   click: 0.15 },
         bass: { cut: 380, g: 0.50, notes: [[2,0,2],[6,0,2],[10,0,2],[14,0,2]] }, hat: 3, clap: 0, arp: 0 },
    4: { pad: 0.40, padCut: 1300, air: 0.03, ping: 0.15, duck: 0.50, kick: { g: 0.90, lp: 0,   click: 0.5 },
         bass: { cut: 560, g: 0.58, notes: [[2,0,1.5],[3,0,1],[6,0,1.5],[7,12,1],[10,0,1.5],[11,0,1],[14,0,1.5],[15,7,1]] }, hat: 4, clap: 0.22, arp: 0.07 },
    5: { pad: 0.36, padCut: 2000, air: 0.03, ping: 0.10, duck: 0.62, kick: { g: 1.00, lp: 0,   click: 0.7 },
         bass: { cut: 800, g: 0.66, notes: [[1,0,1],[2,0,1],[3,12,1],[5,0,1],[6,0,1],[7,7,1],[9,0,1],[10,0,1],[11,12,1],[13,0,1],[14,3,1],[15,10,1]] }, hat: 5, clap: 0.30, arp: 0.10 }
  };
  const ARP4 = [0, 2, 4, 2, 1, 3, 5, 3];
  const ARP5 = [0, 2, 4, 5, 4, 2, 1, 3, 0, 2, 4, 5, 4, 3, 1, 2];

  // ---------------- TILLSTÅND ----------------
  let ctx = null, muted = false, fade = 0;
  let master, mixBus, comp, sfxBus, musicBus, sfxDuck, duckA, reverbIn, convolver, revReturn;
  let white, brown;
  let busPad, busKick, busBass, busHat, busClap, busArp, busPing;
  let fxDelay, dSendArp, dSendPing;
  let padFilter, padVoices = [], padSub, airG;
  const roll = {};
  let offset = 0, nextStep = 0, nextTime = 0, timer = null;
  let curLevel = 1, pendingLevel = null, curChord = -1, pingStep = -1;
  let sp = 0, lastThud = 0;

  // ---------------- HJÄLPFUNKTIONER ----------------
  function gainNode(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function envAD(g, t, peak, a, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function noiseSrc(buf, t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(t, Math.random() * (buf.duration - 0.2));
    s.stop(t + dur + 0.02);
    return s;
  }
  function loopSrc(buf) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true; s.start();
    return s;
  }
  function makeBuffers() {
    const sr = ctx.sampleRate;
    white = ctx.createBuffer(1, sr * 2, sr);
    const w = white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
    brown = ctx.createBuffer(1, sr * 3, sr);
    const b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < b.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
  }
  // Rumsklang: brus som klingar av och blir mörkare med tiden
  function makeIR(sec) {
    const sr = ctx.sampleRate, len = Math.floor(sr * sec);
    const ir = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, a = 0.12 + 0.88 * Math.exp(-t * 2.5);
        y += ((Math.random() * 2 - 1) - y) * a;
        d[i] = y * Math.exp(-t * 2.6) * (i < sr * 0.004 ? i / (sr * 0.004) : 1) * 1.6;
      }
    }
    return ir;
  }

  // ---------------- BYGG LJUDGRAFEN ----------------
  function build() {
    makeBuffers();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3;
    comp.attack.value = 0.005; comp.release.value = 0.2;
    master = gainNode(0.0001);
    mixBus = gainNode(1);
    mixBus.connect(comp); comp.connect(master); master.connect(ctx.destination);

    sfxBus = gainNode(SFX_VOL); sfxBus.connect(mixBus);
    musicBus = gainNode(MUSIC_VOL);
    sfxDuck = gainNode(1);                    // musiken viker lite när kulan slår
    musicBus.connect(sfxDuck); sfxDuck.connect(mixBus);

    reverbIn = gainNode(1);
    convolver = ctx.createConvolver(); convolver.buffer = makeIR(2.4);
    revReturn = gainNode(REVERB_VOL);
    reverbIn.connect(convolver); convolver.connect(revReturn); revReturn.connect(mixBus);

    buildRoll();
    buildMusic();
  }

  // ---------------- 2. RULLJUD (stålkula på stålbana) ----------------
  // Fyra lager som alla styrs av kulans fart:
  //  A. muller: lågt, dovt brus = kulans tyngd som rullar mot banan
  //  B. metallklang: brus genom några smala filter = banans stål som "ringer" svagt.
  //     Filtren går upp i tonhöjd med farten, precis som i verkligheten.
  //  C. varv: ljudet pulserar mycket svagt en gång per varv kulan snurrar (ingen kula är perfekt rund)
  //  D. fräs, små ticks och "tock" varje gång kulan passerar en skarv i banan
  const BALL_CIRCUM_PX = 2 * Math.PI * 50;   // kulans omkrets i pixlar (BALL_RADIUS = 50 i kula.js)
  // [frekvens stilla, extra frekvens vid full fart, Q, nivå vid full fart]
  const ROLL_RINGS = [
    [210,  260, 12, 3.8],
    [470,  520, 12, 2.2],
    [1050, 900, 14, 1.2],
    [2300, 1500, 16, 0.45]
  ];
  function buildRoll() {
    roll.mix = gainNode(ROLL_VOL); roll.mix.connect(sfxBus);
    const rs = gainNode(0.10); roll.mix.connect(rs); rs.connect(reverbIn);

    // A. muller
    roll.lpA = ctx.createBiquadFilter(); roll.lpA.type = "lowpass"; roll.lpA.frequency.value = 120; roll.lpA.Q.value = 0.7;
    roll.gA = gainNode(0);
    loopSrc(brown).connect(roll.lpA); roll.lpA.connect(roll.gA); roll.gA.connect(roll.mix);

    // B + C. metallklang som pulserar lite för varje varv
    roll.am = gainNode(0.85); roll.am.connect(roll.mix);
    roll.rotLfo = ctx.createOscillator(); roll.rotLfo.type = "sine"; roll.rotLfo.frequency.value = 1;
    roll.rotDepth = gainNode(0);
    roll.rotLfo.connect(roll.rotDepth); roll.rotDepth.connect(roll.am.gain); roll.rotLfo.start();
    roll.rings = ROLL_RINGS.map(([f0, df, q, lvl]) => {
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f0 * ROLL_PITCH; bp.Q.value = q;
      const g = gainNode(0);
      loopSrc(white).connect(bp); bp.connect(g); g.connect(roll.am);
      return { bp, g, f0, df, lvl };
    });

    // D. hårt fräs på hög fart
    roll.hp = ctx.createBiquadFilter(); roll.hp.type = "highpass"; roll.hp.frequency.value = 4000;
    const hl = ctx.createBiquadFilter(); hl.type = "lowpass"; hl.frequency.value = 9000;
    roll.gC = gainNode(0);
    loopSrc(white).connect(roll.hp); roll.hp.connect(hl); hl.connect(roll.gC); roll.gC.connect(roll.mix);

    roll.tickAcc = 0; roll.dist = 0; roll.seamAt = SEAM_PX;
  }
  // Ett litet "tick" när kulan går över en ojämnhet
  function tick(t, s) {
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1800 + Math.random() * 3000; bp.Q.value = 3;
    const g = ctx.createGain(); envAD(g, t, (0.02 + 0.06 * s) * (0.4 + Math.random() * 0.6), 0.0008, 0.006 + Math.random() * 0.01);
    noiseSrc(white, t, 0.03).connect(bp); bp.connect(g); g.connect(roll.mix);
  }
  // Ett mjukt metalliskt "tock" när kulan rullar över en skarv mellan två banplåtar
  function seam(t, s) {
    const amp = SEAM_VOL * (0.25 + 0.75 * clamp(s, 0, 1)) * (0.7 + Math.random() * 0.3);
    const f = (520 + Math.random() * 120) * ROLL_PITCH;
    [[1, 0.30, 0.060], [2.4, 0.16, 0.035], [4.1, 0.07, 0.020]].forEach(([r, a, d]) => {
      const g = ctx.createGain(); envAD(g, t, a * amp, 0.0008, d);
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f * r;
      o.connect(g); g.connect(roll.mix); o.start(t); o.stop(t + d + 0.05);
    });
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 1;
    const cg = ctx.createGain(); envAD(cg, t, 0.18 * amp, 0.0004, 0.010);
    noiseSrc(white, t, 0.03).connect(bp); bp.connect(cg); cg.connect(roll.mix);
  }

  function updateRoll(dt, speed, held, fric) {
    const t = ctx.currentTime;
    const target = held ? 0 : clamp(speed / 900, 0, 1.3);
    // snabb attack, långsam avklingning: ljudet klingar av naturligt när kulan stannar
    sp += (target - sp) * (1 - Math.exp(-dt / (target > sp ? 0.06 : 0.45)));
    if (sp < 0.0005) sp = 0;
    const s = sp, fr = clamp(fric, 0, 1), tc = 0.05;

    roll.gA.gain.setTargetAtTime(0.55 * Math.pow(s, 0.8), t, tc);
    roll.lpA.frequency.setTargetAtTime((80 + 420 * s) * ROLL_PITCH, t, tc);
    roll.rings.forEach(r => {
      r.bp.frequency.setTargetAtTime((r.f0 + r.df * s) * ROLL_PITCH, t, tc);
      r.g.gain.setTargetAtTime(r.lvl * Math.pow(s, 1.15) * (1 + 0.5 * fr), t, tc);
    });
    // en pulsering per varv: varvtalet = fart / omkrets
    roll.rotLfo.frequency.setTargetAtTime(Math.max(0.3, s * 900 / BALL_CIRCUM_PX), t, 0.1);
    roll.rotDepth.gain.setTargetAtTime(0.18 * Math.min(1, s * 3), t, 0.1);
    roll.gC.gain.setTargetAtTime(0.05 * Math.pow(clamp((s - 0.3) / 0.7, 0, 1), 1.5), t, tc);

    if (s > 0.05) {                            // slumpmässiga små ticks, tätare med farten
      roll.tickAcc += (2 + 10 * s) * dt;
      while (roll.tickAcc >= 1) { roll.tickAcc--; tick(t + Math.random() * dt, s); }
    } else roll.tickAcc = 0;

    if (SEAM_VOL > 0 && !held && speed > 40) { // skarvar: ett "tock" per SEAM_PX pixlar
      roll.dist += speed * dt;
      if (roll.dist >= roll.seamAt) {
        roll.dist -= roll.seamAt;
        roll.seamAt = SEAM_PX * (0.75 + 0.5 * Math.random());
        seam(t + 0.002, clamp(speed / 900, 0, 1.2));
      }
    }
  }

  // ---------------- 1. METALLISKT KLONK (kulan släpps / krockar) ----------------
  // Stålkula mot stålbana: ett kort, hårt "klonk" som klingar av snabbt.
  //  - fem ojämna toner (inte som en klocka) som klingar av olika fort = metallen
  //  - kulans egen korta höga ring, banans dova "boom" och en tung tunk
  //  - ett hårt brusklick (själva kontakten) och ett kort slap
  //  - hårdare slag öppnar ett filter så att klonket låter ljusare
  function impact(t, power, o) {
    const p = clamp(power, 0.05, 1.2);
    const out = gainNode(KLONK_VOL * (0.40 + 0.60 * p) * 0.6); out.connect(sfxBus);
    const send = gainNode(0.16); out.connect(send); send.connect(reverbIn);
    const tilt = ctx.createBiquadFilter(); tilt.type = "lowpass"; tilt.Q.value = 0.3;
    tilt.frequency.value = 2500 + 9000 * Math.min(1, p) * o.bright;
    tilt.connect(out);

    const tone = (freq, pk, decay, dest) => {
      if (freq > 15000) return;
      const g = ctx.createGain(); envAD(g, t, pk, 0.0008, Math.max(0.015, decay));
      const os = ctx.createOscillator(); os.type = "sine"; os.frequency.value = freq;
      os.connect(g); g.connect(dest || tilt); os.start(t); os.stop(t + decay + 0.1);
    };
    const f1 = o.f * KLONK_PITCH * (1 + (Math.random() - 0.5) * 0.05);
    const ring = KLONK_RING * o.dec * (0.55 + 0.45 * p);

    [[1, 0.50, 0.30], [2.32, 0.38, 0.18], [4.18, 0.24, 0.11], [6.43, 0.14, 0.07], [9.1, 0.07, 0.04]]
      .forEach(([r, a, d], i) => {
        tone(f1 * r * (1 + (Math.random() - 0.5) * 0.01), a * (i > 0 ? o.bright : 1), d * ring);
        if (i === 0) tone(f1 * 1.006, a * 0.4, d * ring * 1.15);   // lätt svävning = levande metall
      });
    tone(3600 + Math.random() * 1200, 0.09 * o.bright, 0.07 * ring);   // kulans korta ring
    tone(f1 * 0.5, 0.28 * o.body, 0.30 * ring);                        // banans dova boom

    const th = ctx.createOscillator(), tg = ctx.createGain(); th.type = "sine";   // tung tunk
    th.frequency.setValueAtTime(150, t); th.frequency.exponentialRampToValueAtTime(80, t + 0.06);
    envAD(tg, t, 0.5 * o.body, 0.001, 0.12); th.connect(tg); tg.connect(out); th.start(t); th.stop(t + 0.2);

    const clickHP = ctx.createBiquadFilter(); clickHP.type = "highpass"; clickHP.frequency.value = 2200;
    const cg = ctx.createGain(); envAD(cg, t, 0.50 * o.bright, 0.0004, 0.007);
    noiseSrc(white, t, 0.03).connect(clickHP); clickHP.connect(cg); cg.connect(out);

    const slapBP = ctx.createBiquadFilter(); slapBP.type = "bandpass"; slapBP.frequency.value = 1300; slapBP.Q.value = 1;
    const sg = ctx.createGain(); envAD(sg, t, 0.25 * o.bright, 0.0008, 0.035);
    noiseSrc(white, t, 0.06).connect(slapBP); slapBP.connect(sg); sg.connect(out);
  }
  function duck(t, depth) {
    sfxDuck.gain.setTargetAtTime(1 - depth, t, 0.01);
    sfxDuck.gain.setTargetAtTime(1, t + 0.12, 0.22);
  }
  // Kulan släpps på banan: ett tungt klonk och några snabbt avtagande studsar
  function drop(power) {
    if (!ctx || ctx.state !== "running") return;
    const p = power === undefined ? 0.8 : power;
    const t = ctx.currentTime + 0.005, f = 560 + Math.random() * 60;
    impact(t,         p,        { f: f,        dec: 1,    body: 1,    bright: 1 });
    impact(t + 0.095, p * 0.35, { f: f * 1.05, dec: 0.5,  body: 0.3,  bright: 1 });
    impact(t + 0.165, p * 0.14, { f: f * 1.09, dec: 0.35, body: 0.1,  bright: 1 });
    impact(t + 0.210, p * 0.06, { f: f * 1.12, dec: 0.3,  body: 0.05, bright: 1 });
    impact(t + 0.240, p * 0.025,{ f: f * 1.15, dec: 0.25, body: 0.02, bright: 1 });
    duck(t, 0.35);
  }
  // Kulan krockar i banans ände: lägre, tyngre klonk
  function thud(power) {
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.003;
    if (t - lastThud < 0.15) return;
    lastThud = t;
    impact(t, clamp(power === undefined ? 0.5 : power, 0.1, 1), { f: 340, dec: 1.3, body: 1.5, bright: 0.7 });
    duck(t, 0.25);
  }

  // ---------------- 3. MUSIK ----------------
  function buildMusic() {
    busPad = gainNode(0); busKick = gainNode(1); busBass = gainNode(1); busHat = gainNode(1);
    busClap = gainNode(1); busArp = gainNode(1); busPing = gainNode(1);
    duckA = gainNode(1); duckA.connect(musicBus);
    busPad.connect(duckA); busBass.connect(duckA); busArp.connect(duckA);
    busKick.connect(musicBus); busHat.connect(musicBus); busClap.connect(musicBus); busPing.connect(musicBus);
    // rumsklang
    for (const [bus, v] of [[busPad, 0.35], [busClap, 0.4], [busArp, 0.25], [busPing, 0.6], [busHat, 0.12]]) {
      const s = gainNode(v); bus.connect(s); s.connect(reverbIn);
    }
    // punkterad åttondelsdelay (arpeggio och ping)
    fxDelay = ctx.createDelay(1); fxDelay.delayTime.value = STEP * 3;
    const fbLP = ctx.createBiquadFilter(); fbLP.type = "lowpass"; fbLP.frequency.value = 3200;
    const fb = gainNode(0.42);
    fxDelay.connect(fbLP); fbLP.connect(fb); fb.connect(fxDelay);
    const fxOut = gainNode(0.55); fbLP.connect(fxOut); fxOut.connect(musicBus);
    dSendArp = gainNode(0.5); busArp.connect(dSendArp); dSendArp.connect(fxDelay);
    dSendPing = gainNode(0.9); busPing.connect(dSendPing); dSendPing.connect(fxDelay);

    // Pad: fyra toner, varje med två lätt förstämda sågtandsvågor, långsamt rörligt filter
    padFilter = ctx.createBiquadFilter(); padFilter.type = "lowpass"; padFilter.frequency.value = 520; padFilter.Q.value = 1.2;
    padFilter.connect(busPad);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    const lfoD = gainNode(220); lfo.connect(lfoD); lfoD.connect(padFilter.frequency); lfo.start();
    for (let i = 0; i < 4; i++) {
      const vg = gainNode(0.16); vg.connect(padFilter);
      const oscs = [-7, 7].map(det => {
        const o = ctx.createOscillator(); o.type = "sawtooth"; o.detune.value = det;
        o.frequency.value = mtof(PROG[0].pad[i]); o.connect(vg); o.start(); return o;
      });
      padVoices.push(oscs);
    }
    padSub = ctx.createOscillator(); padSub.type = "sine"; padSub.frequency.value = mtof(PROG[0].root);
    const sg = gainNode(0.35); padSub.connect(sg); sg.connect(busPad); padSub.start();
    // Luft: svagt, långsamt andande brus
    const airBP = ctx.createBiquadFilter(); airBP.type = "bandpass"; airBP.frequency.value = 3000; airBP.Q.value = 0.5;
    airG = gainNode(0);
    loopSrc(white).connect(airBP); airBP.connect(airG); airG.connect(busPad);
    const aLfo = ctx.createOscillator(); aLfo.frequency.value = 0.11;
    const aD = gainNode(0.02); aLfo.connect(aD); aD.connect(airG.gain); aLfo.start();
  }

  function setChord(idx, t, immediate) {
    const c = PROG[idx];
    padVoices.forEach((oscs, i) => oscs.forEach(o => {
      if (immediate) o.frequency.setValueAtTime(mtof(c.pad[i]), t);
      else o.frequency.setTargetAtTime(mtof(c.pad[i]), t, 0.5);
    }));
    if (immediate) padSub.frequency.setValueAtTime(mtof(c.root), t);
    else padSub.frequency.setTargetAtTime(mtof(c.root), t, 0.5);
    curChord = idx;
  }
  function applyLevel(n, t, fast) {
    const L = LV[n], tc = fast ? 0.15 : 0.8;
    busPad.gain.setTargetAtTime(L.pad, t, tc);
    padFilter.frequency.setTargetAtTime(L.padCut, t, tc);
    airG.gain.setTargetAtTime(L.air, t, tc);
  }

  // --- instrument ---
  function kick(t, k) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine";
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    envAD(g, t, k.g, 0.003, 0.42);
    if (k.lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = k.lp; o.connect(f); f.connect(g); }
    else o.connect(g);
    g.connect(busKick); o.start(t); o.stop(t + 0.48);
    if (k.click > 0) {
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1800;
      const cg = ctx.createGain(); envAD(cg, t, k.click * k.g * 0.35, 0.0005, 0.012);
      noiseSrc(white, t, 0.03).connect(hp); hp.connect(cg); cg.connect(busKick);
    }
  }
  function bassNote(t, midi, lenSteps, cut, gain, lvl) {
    const f = mtof(midi + 12), len = Math.max(0.06, lenSteps * STEP * 0.85);
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
    const sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = f / 2;
    const flt = ctx.createBiquadFilter(); flt.type = "lowpass"; flt.Q.value = lvl >= 5 ? 6 : 4;
    flt.frequency.setValueAtTime(cut * 2.6, t); flt.frequency.exponentialRampToValueAtTime(cut, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.setValueAtTime(gain, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.07);
    const sg = gainNode(0.8);
    o.connect(flt); flt.connect(g); sub.connect(sg); sg.connect(g); g.connect(busBass);
    o.start(t); sub.start(t); o.stop(t + len + 0.1); sub.stop(t + len + 0.1);
  }
  function hat(t, open, gain) {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7200;
    const g = ctx.createGain(); envAD(g, t, gain, 0.001, open ? 0.16 : 0.035);
    noiseSrc(white, t, open ? 0.2 : 0.06).connect(hp); hp.connect(g); g.connect(busHat);
  }
  function clap(t, gain) {
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1400; bp.Q.value = 0.9;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    for (const k of [0, 0.011, 0.022]) {
      g.gain.setValueAtTime(gain, t + k);
      g.gain.exponentialRampToValueAtTime(gain * 0.2, t + k + 0.009);
    }
    g.gain.setValueAtTime(gain * 0.9, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    noiseSrc(white, t, 0.22).connect(bp); bp.connect(g); g.connect(busClap);
  }
  function pluck(t, midi, gain, cut) {
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = mtof(midi);
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 3;
    f.frequency.setValueAtTime(cut, t); f.frequency.exponentialRampToValueAtTime(cut * 0.25, t + 0.16);
    const g = ctx.createGain(); envAD(g, t, gain, 0.002, 0.2);
    o.connect(f); f.connect(g); g.connect(busArp); o.start(t); o.stop(t + 0.26);
  }
  function ping(t, midi) {
    const g = ctx.createGain(); envAD(g, t, 0.16, 0.005, 1.4);
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = mtof(midi);
    const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = mtof(midi) * 2;
    const g2 = gainNode(0.2);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(busPing);
    o.start(t); o2.start(t); o.stop(t + 1.5); o2.stop(t + 1.5);
  }
  function boom(t) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine";
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.9);
    envAD(g, t, 0.45, 0.004, 1.1); o.connect(g); g.connect(busKick); o.start(t); o.stop(t + 1.2);
  }
  // Uppgång inför ett högre nivåsteg: filtrerat brus som stiger fram till nästa takt
  function swoosh(t0, t1) {
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(350, t0); bp.frequency.exponentialRampToValueAtTime(6500, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.22, t1 - 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t1 + 0.06);
    noiseSrc(white, t0, t1 - t0 + 0.1).connect(bp); bp.connect(g); g.connect(busHat);
  }

  // --- sekvenserare ---
  function scheduleStep(s, t) {
    const bar = s % 16;
    if (bar === 0 && pendingLevel !== null) {
      const up = pendingLevel > curLevel;
      curLevel = pendingLevel; pendingLevel = null;
      applyLevel(curLevel, t, false);
      if (up) boom(t);
    }
    const L = LV[curLevel];
    const ci = Math.floor(s / 32) % 4;
    if (ci !== curChord) setChord(ci, t, false);
    const chord = PROG[ci];

    if (L.kick && KICK_STEPS.includes(bar)) {
      kick(t, L.kick);
      if (L.duck > 0) {                       // sidechain-pump
        duckA.gain.setValueAtTime(1 - L.duck, t);
        duckA.gain.linearRampToValueAtTime(1, t + 0.22);
      }
    }
    if (L.bass) for (const n of L.bass.notes) if (n[0] === bar) bassNote(t, chord.root + n[1], n[2], L.bass.cut, L.bass.g, curLevel);

    if (L.hat === 3) { if (bar % 4 === 2) hat(t, true, 0.10); }
    else if (L.hat === 4) { if (bar % 4 === 2) hat(t, true, 0.12); else if (bar % 4 === 0) hat(t, false, 0.06); else if (bar % 2 === 1) hat(t, false, 0.035); }
    else if (L.hat === 5) { if (bar % 4 === 2) hat(t, true, 0.14); else if (bar % 2 === 1) hat(t, false, 0.07); else hat(t, false, 0.05); }

    if (L.clap > 0 && (bar === 4 || bar === 12 || (curLevel === 5 && bar === 15))) clap(t, bar === 15 ? L.clap * 0.35 : L.clap);

    if (L.arp > 0) {
      if (curLevel === 4 && bar % 2 === 0) pluck(t, chord.arp[ARP4[(bar / 2) % 8]], L.arp, 1800);
      else if (curLevel === 5) pluck(t, chord.arp[ARP5[bar]] + (bar % 8 === 7 ? 12 : 0), L.arp, 2600);
    }

    if (bar === 0) pingStep = Math.random() < L.ping ? pick([3, 6, 7, 10, 11, 14]) : -1;
    if (bar === pingStep) ping(t, pick(chord.arp) + 12);
  }
  function scheduler() {
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    while (nextTime < now + 0.25) {
      if (nextTime >= now - 0.05) scheduleStep(nextStep, nextTime);   // missade steg (bakgrundsflik) hoppas över
      nextTime += STEP; nextStep++;
    }
  }

  function setLevel(n) {
    n = clamp(Math.round(n), 1, 5);
    const target = pendingLevel !== null ? pendingLevel : curLevel;
    if (n === target) return;
    if (n === curLevel) { pendingLevel = null; return; }
    pendingLevel = n;                         // byts på nästa takt så att det låter musikaliskt
    if (n > curLevel) {
      const toBar = (16 - (nextStep % 16)) % 16, tb = nextTime + toBar * STEP, t0 = ctx.currentTime + 0.03;
      if (tb - t0 > 0.35) swoosh(t0, tb);
    }
  }

  // ---------------- OFFENTLIGT API ----------------
  // Anropas från startknappen (kräver användargest). nowSec = millis()/1000 i kula.js,
  // så att musikens taktslag hamnar på samma slag som ljuspulsen.
  function start(nowSec, level) {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC({ latencyHint: "interactive" });
    build();
    offset = ctx.currentTime - nowSec;
    nextStep = Math.ceil((nowSec + 0.1) / STEP);
    nextTime = nextStep * STEP + offset;
    curLevel = clamp(level || 1, 1, 5);
    setChord(Math.floor(nextStep / 32) % 4, ctx.currentTime, true);
    applyLevel(curLevel, ctx.currentTime, true);
    timer = setInterval(scheduler, 40);
    document.addEventListener("visibilitychange", () => { if (ctx && !document.hidden) ctx.resume(); });
    ctx.resume();
    fadeIn(1.8);
    return true;
  }
  function update(o) {
    if (!ctx || ctx.state !== "running") return;
    setLevel(o.level);
    updateRoll(Math.min(0.05, Math.max(0.001, o.dt || 0.016)), o.speed || 0, !!o.held, o.fric || 0);
  }
  function masterTarget() { return muted ? 0.0001 : Math.max(0.0001, (1 - fade) * MASTER_VOL); }
  function setFade(a) {                       // följer nedtoningen till svart
    fade = clamp(a, 0, 1);
    if (ctx) master.gain.setTargetAtTime(masterTarget(), ctx.currentTime, 0.05);
  }
  function fadeIn(sec) {                      // uppdragning efter start/återställning
    fade = 0;
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(0.0001, t);
    master.gain.linearRampToValueAtTime(muted ? 0.0001 : MASTER_VOL, t + Math.max(0.05, sec));
  }
  function reset() {                          // tillbaka till nivå 1 direkt (görs medan det är svart)
    if (!ctx) return;
    curLevel = 1; pendingLevel = null; sp = 0;
    applyLevel(1, ctx.currentTime, true);
  }
  function toggleMute() {
    muted = !muted;
    if (ctx) master.gain.setTargetAtTime(masterTarget(), ctx.currentTime, 0.05);
    return muted;
  }
  return { start, update, drop, thud, setFade, fadeIn, reset, toggleMute, get muted() { return muted; } };
})();