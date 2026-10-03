// The Forge Agent — renderer.
//
// Sign-in, presence, the rolling screen buffer, and answering an organiser's
// request for the last minute of it. The main process owns everything that
// touches the OS; this file owns everything that touches Firebase.
//
// Nothing here judges anything. It reports what is on screen and what is
// running; the dashboard does the matching and a person does the deciding.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  GoogleAuthProvider, signInWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, query, where, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getDatabase, forceWebSockets, ref, push, set, update, remove, onValue, onDisconnect,
  serverTimestamp as dbNow,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// Kept in step with config.js on the website by hand — the agent cannot
// import from there, and duplicating six public strings beats a build step.
const firebaseConfig = {
  apiKey: "AIzaSyAZTF3pGnR0IF8y7wiH0RUv_HTibUWkw5c",
  authDomain: "theforge-b77f7.firebaseapp.com",
  projectId: "theforge-b77f7",
  databaseURL: "https://theforge-b77f7-default-rtdb.asia-southeast1.firebasedatabase.app",
  storageBucket: "theforge-b77f7.firebasestorage.app",
  messagingSenderId: "1002178068590",
  appId: "1:1002178068590:web:276256f81ba72a5854667f",
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const fs = getFirestore(fbApp);
// WebSocket only. The SDK marks WebSockets as failed before every attempt and
// clears the mark once one succeeds, so a quit or a wifi drop mid-connect
// leaves it set — and from then on it opens with long-polling, which loads
// scripts from the database host that our CSP rightly blocks. That stranded
// the agent on "can't reach the organisers' dashboard" for good.
forceWebSockets();
const rdb = getDatabase(fbApp);

const SEGMENT_MS = 20_000;   // each clip covers this much
const KEEP_SEGMENTS = 3;     // ...and we hold three, so 40-60s at any moment
const SAMPLE_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const CONSENT_KEY = "forge.agent.consent.v1";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("show"));
  $(id).classList.add("show");
}

let host = { host: "mac", displayCount: 1, version: "1.0.0", dev: false };

/* ============================================================ permissions */

let permPoll = null;

function paintPerms(p) {
  const screenOk = p.screen === "granted";
  $("dotScreen").className = `dot ${screenOk ? "ok" : "no"}`;
  $("dotAx").className = `dot ${p.accessibility ? "ok" : "no"}`;

  // getMediaAccessStatus("screen") is cached for the life of the process and
  // macOS does not apply a new grant to a running app anyway, so this can
  // never flip to granted while we sit here. Restarting is the only path.
  // Never trap anyone here. The status is cached for the life of the process
  // and, run from a terminal, macOS attributes the grant to the terminal
  // rather than to us — so "not granted" can be wrong and unfixable from
  // inside this screen. Continuing without it is a reported state, not a
  // blocked one: presence carries capture: "denied" and the dashboard says so.
  $("permsNext").disabled = false;
  $("permsNext").textContent = screenOk || host.dev ? "Continue" : "Continue anyway";
  $("permsNote").textContent = screenOk
    ? "Screen recording is on. Accessibility can be granted at any time — the agent picks it up on its own."
    : "macOS does not apply a new screen-recording grant to an app that is already running. Once you have ticked it, the agent has to restart.";
}

async function gatePermissions() {
  // A status check alone never registers the app with macOS privacy, so
  // until something attempts a capture the agent is not even listed for the
  // participant to tick. This priming call is what puts it there.
  let p = await window.forge.checkPermissions({ prime: true });

  if (p.screen === "granted" && p.accessibility) return;
  if (host.dev && p.screen === "granted") return;

  show("scPerms");
  paintPerms(p);

  await new Promise((resolve) => {
    permPoll = setInterval(async () => {
      paintPerms(await window.forge.checkPermissions());
    }, 2000);

    $("permsNext").onclick = () => {
      clearInterval(permPoll);
      resolve();
    };
  });
}

document.querySelectorAll("[data-open]").forEach((b) => {
  b.onclick = () => window.forge.openSettings(b.dataset.open);
});
$("axPrompt").onclick = () => window.forge.promptAccessibility();
$("permsRestart").onclick = () => window.forge.relaunch();

/* ================================================================ capture */

let stream = null;
let activeRecorder = null;
let currentSegment = null;
let segments = [];
let rotating = false;
let captureState = "off";   // off | on | denied | stopped

function pickMime() {
  // VP8, not VP9: this is a software encode of a screen source, and VP9's
  // encoder is expensive enough that participants notice their fans.
  return MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
    ? "video/webm;codecs=vp8"
    : "video/webm";
}

/**
 * One complete, self-contained WebM.
 *
 * Deliberately started with no timeslice. A rolling buffer built by slicing
 * timesliced chunks does not work: the first chunk carries the EBML header
 * and track definitions, so dropping it leaves an unplayable file, and the
 * chunks are not cluster-aligned so splicing the header back on does not
 * reliably fix it either. Rotating whole recordings sidesteps all of that —
 * every segment plays on its own, and they are never concatenated.
 */
function recordSegment() {
  return new Promise((resolve) => {
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 500_000 });
    const parts = [];
    const startedAt = Date.now();
    let timer = null;

    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onerror = () => { try { rec.stop(); } catch { /* already gone */ } };
    rec.onstop = () => {
      clearTimeout(timer);
      activeRecorder = null;
      resolve({ blob: new Blob(parts, { type: mimeType }), startedAt, endedAt: Date.now() });
    };

    activeRecorder = rec;
    rec.start();
    timer = setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, SEGMENT_MS);
  });
}

async function rotateLoop() {
  rotating = true;
  while (rotating && stream) {
    currentSegment = recordSegment();
    const seg = await currentSegment;
    if (seg.blob.size) segments.push(seg);
    // This is the whole of the retention policy: anything older than the
    // last three segments is dropped and never written anywhere.
    while (segments.length > KEEP_SEGMENTS) segments.shift();
    paintRunning();
  }
  currentSegment = null;
}

/** End the in-progress segment now, so a pull includes the last few seconds. */
async function cutSegment() {
  const pending = currentSegment;
  if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
  if (pending) await pending;
  await sleep(60);   // let rotateLoop push it
}

async function startCapture() {
  if (host.dev) { captureState = "off"; return; }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 4, max: 5 }, width: { max: 1280 }, height: { max: 800 } },
    });
  } catch {
    captureState = "denied";
    return;
  }

  const track = stream.getVideoTracks()[0];
  // Constraints are advisory for desktop sources, and a Retina screen is
  // 3456x2234 — without a second pass a minute of it is tens of megabytes.
  try { await track.applyConstraints({ frameRate: 4, width: 1280, height: 800 }); } catch { /* best effort */ }
  console.log("capture:", track.getSettings());

  track.addEventListener("ended", () => {
    captureState = "stopped";
    rotating = false;
    paintRunning();
  });

  captureState = "on";
  rotateLoop();
}

function bufferSeconds() {
  return Math.round(segments.reduce((n, s) => n + (s.endedAt - s.startedAt), 0) / 1000);
}

/* =============================================================== presence */

let me = null;             // { uid, name, email, teamId, teamName }
let myConn = null;
let timers = [];
let lastActivitySig = "";
let lastSampleAt = 0;
let pullCount = 0;
let titlesState = "unknown";   // ok | denied | unknown

function stopEverything() {
  timers.forEach(clearInterval);
  timers = [];
  rotating = false;
  if (activeRecorder && activeRecorder.state !== "inactive") {
    try { activeRecorder.stop(); } catch { /* already finishing */ }
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  segments = [];
  captureState = "off";
  myConn = null;
  lastActivitySig = "";
}

async function resolveProfile(user) {
  const snap = await getDoc(doc(fs, "users", user.uid));
  if (!snap.exists()) return null;
  const p = snap.data();

  let teamId = "";
  let teamName = "";
  try {
    const q = query(
      collection(fs, "teams"),
      where("memberUids", "array-contains", user.uid),
      limit(1)
    );
    const teams = await getDocs(q);
    if (!teams.empty) {
      teamId = teams.docs[0].id;
      teamName = teams.docs[0].data().name || "";
    }
  } catch { /* no team yet, or rules said no — the dashboard copes */ }

  return {
    uid: user.uid,
    name: p.name || user.displayName || user.email,
    email: user.email || "",
    teamId,
    teamName,
  };
}

/**
 * Presence, keyed by connection rather than by user.
 *
 * A single /presence/{uid} node breaks on a quick relaunch: the dying
 * instance's onDisconnect lands *after* the new one has registered and marks
 * the participant offline. A pushed child per connection cannot do that, and
 * it also means a second machine shows up as a second connection rather than
 * silently overwriting the first.
 *
 * onDisconnect is armed before the write, not after, so a kill in between
 * still leaves nothing behind.
 */
function startPresence() {
  const connsRef = ref(rdb, `presence/${me.uid}/conns`);
  const metaRef = ref(rdb, `presence/${me.uid}/meta`);

  onValue(ref(rdb, ".info/connected"), async (snap) => {
    if (snap.val() !== true) { paintLive(false); return; }

    // Say we're up as soon as the socket is up. Everything below can still be
    // refused — unreleased rules deny every write — and burying this line at
    // the end meant a rejected write left the agent claiming it could not
    // reach anything, which sends people to look at their wifi.
    paintLive(true);

    try {

    const c = push(connsRef);
    await onDisconnect(c).remove();
    await set(c, {
      since: dbNow(),
      lastSeen: dbNow(),
      host: host.host,
      app: host.version,
      displayCount: host.displayCount,
      capture: captureState,
      titles: titlesState,
    });
    myConn = c;

    await update(metaRef, {
      name: me.name,
      email: me.email,
      teamId: me.teamId,
      teamName: me.teamName,
      lastSeen: dbNow(),
      // clear a previous deliberate quit, so the dashboard shows this
      // session and not the last one's epitaph
      closedBy: null,
      closedAt: null,
    });

    } catch (err) {
      paintLive(false, err.code || err.message);
    }
  });

  // onDisconnect covers a quit and a kill -9 alike, because either way the
  // kernel closes the socket. What it does not cover is a lid closing or
  // wifi dropping, where the server waits on its own keepalive. The
  // heartbeat is how the dashboard tells those two apart.
  timers.push(setInterval(async () => {
    if (!myConn) return;
    try {
      await update(myConn, { lastSeen: dbNow(), capture: captureState, titles: titlesState });
      await update(metaRef, { lastSeen: dbNow() });
    } catch { /* offline; the SDK will replay when it reconnects */ }
  }, HEARTBEAT_MS));
}

/* =============================================================== activity */

async function activityTick() {
  let s;
  try { s = await window.forge.sample(); } catch { return; }

  titlesState = s.titlesOk ? "ok" : (s.titlesDenied ? "denied" : "unknown");
  lastSampleAt = Date.now();

  const payload = { frontApp: s.frontApp || "", frontTitle: s.frontTitle || "" };
  if (s.windows.length) payload.windows = s.windows;
  if (s.processes.length) payload.processes = s.processes;

  // Only write when something actually changed. Over a whole hackathon this
  // is the difference between a few kilobytes and a few megabytes, and the
  // heartbeat already proves the agent is alive.
  const sig = JSON.stringify(payload);
  if (sig !== lastActivitySig) {
    lastActivitySig = sig;
    try { await set(ref(rdb, `activity/${me.uid}`), { at: dbNow(), ...payload }); } catch { /* retried next tick */ }
  }

  paintRunning(s);
}

/* =================================================================== pull */

let handledPull = null;

let frozen = false;

/* Driven entirely by the dashboard; the agent holds no opinion about when a
   freeze is warranted, same as everything else here. */
function watchFreeze() {
  onValue(ref(rdb, `freeze/${me.uid}`), (snap) => {
    const on = !!(snap.val() && snap.val().on);
    if (on === frozen) return;
    frozen = on;
    window.forge.setFrozen(on);
    if (on) {
      $("frozenWhen").textContent = `Paused at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      show("scFrozen");
    } else {
      show("scRun");
    }
  }, () => { /* unreadable freeze must not take the agent down */ });
}

function watchPulls() {
  onValue(ref(rdb, `pull/${me.uid}/request`), async (snap) => {
    const req = snap.val();
    if (!req || !req.id || req.id === handledPull) return;
    handledPull = req.id;
    pullCount += 1;
    paintRunning();
    await answerPull(req);
  }, () => { /* denied reads are not fatal to the rest of the agent */ });
}

async function answerPull(req) {
  const resultRef = ref(rdb, `pull/${me.uid}/result`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");

  try {
    if (captureState !== "on") {
      await set(resultRef, {
        at: dbNow(), for: req.id,
        status: `no buffer — screen capture is ${captureState}`,
      });
      return;
    }

    await cutSegment();
    const segs = segments.slice(-KEEP_SEGMENTS);

    const files = [];
    let bytes = 0;
    let ms = 0;
    for (let i = 0; i < segs.length; i++) {
      const data = new Uint8Array(await segs[i].blob.arrayBuffer());
      const span = segs[i].endedAt - segs[i].startedAt;
      files.push({ name: `${stamp}-${i + 1}.webm`, data, ms: span });
      bytes += data.length;
      ms += span;
    }

    if (!files.length) {
      await set(resultRef, { at: dbNow(), for: req.id, status: "no buffer yet" });
      return;
    }

    const saved = await window.forge.saveClips({ stamp, files });

    // The clips stay on the machine. A single still goes up so an organiser
    // knows whether it is worth walking over for the rest.
    let poster = null;
    try { poster = await window.forge.poster(); } catch { /* optional */ }

    await set(resultRef, {
      at: dbNow(),
      for: req.id,
      status: "saved-on-device",
      seconds: Math.round(ms / 1000),
      bytes,
      folder: saved.folder,
      files: saved.files,
      ...(poster ? { poster } : {}),
    });
  } catch (err) {
    try {
      await set(resultRef, {
        at: dbNow(), for: req.id,
        status: `failed: ${String(err && err.message || err).slice(0, 150)}`,
      });
    } catch { /* nothing more we can do from here */ }
  }
}

/* ================================================================ painting */

let everConnected = false;

function paintLive(connected, refused) {
  if (connected) everConnected = true;
  $("liveDot").className = `dot ${connected ? "ok" : "no"}`;

  // Three different states that all used to read as one. "Reconnecting" is a
  // lie if we never got up once, and "can't reach" is a lie if we reached it
  // fine and it turned us away — the first sends people to their wifi, the
  // second to whoever forgot to deploy the rules.
  $("liveText").textContent = connected
    ? "Connected to the organisers' dashboard"
    : refused
      ? `The database turned us away (${refused}) — tell an organiser`
      : everConnected
        ? "Reconnecting…"
        : "Can't reach the organisers' dashboard — check with them";
}

function paintRunning(sample) {
  $("tBuffer").textContent =
    captureState === "on" ? `${bufferSeconds()}s held`
      : captureState === "denied" ? "Not permitted"
        : captureState === "stopped" ? "Stopped"
          : "Off";

  $("tTitles").textContent =
    titlesState === "ok" ? "Reporting"
      : titlesState === "denied" ? "Not permitted"
        : "—";

  $("tSample").textContent = lastSampleAt
    ? new Date(lastSampleAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  $("tPulls").textContent = String(pullCount);

  if (sample) {
    const lines = [];
    if (sample.frontApp) lines.push(`Front: ${sample.frontApp}${sample.frontTitle ? ` — ${sample.frontTitle}` : ""}`);
    if (sample.windows.length) lines.push(`${sample.windows.length} open windows`);
    if (sample.processes.length) lines.push(`${sample.processes.length} applications running`);
    if (titlesState === "denied") lines.push("Window titles unavailable — Accessibility is off");

    const feed = $("feed");
    feed.textContent = "";
    for (const l of lines) {
      const d = document.createElement("div");
      d.textContent = l;      // never innerHTML: these are window titles
      feed.appendChild(d);
    }
  }
}

/* =================================================================== auth */

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  const msg = $("loginMsg");
  btn.disabled = true;
  msg.textContent = "";

  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    $("password").value = "";
  } catch (err) {
    const code = String(err.code || "");
    msg.textContent =
      code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")
        ? "That email and password don't match an account."
        : code.includes("network")
          ? "Can't reach Firebase — check the wifi."
          : `Couldn't sign in — ${code || err.message}`;
  } finally {
    btn.disabled = false;
  }
});

/* The browser half of this runs in main — Google refuses OAuth inside an
   embedded webview, so the only workable route is the real browser and a
   loopback redirect. What comes back is a Google ID token, which Firebase
   accepts in place of the popup credential the website uses. */
$("googleBtn").onclick = async () => {
  const btn = $("googleBtn");
  const msg = $("googleMsg");
  btn.disabled = true;
  btn.textContent = "Waiting for your browser…";
  msg.textContent = "";

  try {
    const r = await window.forge.googleSignIn();
    if (r.error) {
      msg.textContent = r.error === "not-configured"
        ? "Google sign-in isn't set up in this build."
        : `Couldn't sign in — ${r.error}`;
      return;
    }
    await setPersistence(auth, browserLocalPersistence);
    await signInWithCredential(auth, GoogleAuthProvider.credential(r.idToken));
  } catch (err) {
    // invalid-credential here almost always means the OAuth client lives in
    // a different Google Cloud project than Firebase does.
    msg.textContent = `Couldn't sign in — ${err.code || err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Continue with Google";
  }
};

$("signOut").onclick = async () => {
  try { if (myConn) await remove(myConn); } catch { /* going anyway */ }
  stopEverything();
  await signOut(auth);
};

$("revealBtn").onclick = (e) => { e.preventDefault(); window.forge.revealIncidents(); };

function wireAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      stopEverything();
      show("scLogin");
      return;
    }

    me = await resolveProfile(user);
    if (!me) {
      await signOut(auth);
      $("loginMsg").textContent =
        "That account has no Forge profile yet — finish signing up on the website first.";
      show("scLogin");
      return;
    }

    $("whoami").textContent = me.teamName ? `${me.name} · ${me.teamName}` : me.name;
    show("scRun");

    await startCapture();
    startPresence();
    watchPulls();
    watchFreeze();

    await activityTick();
    timers.push(setInterval(activityTick, SAMPLE_MS));
    timers.push(setInterval(() => paintRunning(), 1000));
  });
}

// Main has already warned them and they said yes. This just records that it
// was deliberate, so the dashboard can distinguish a quit from a crash.
window.forge.onClosing(async () => {
  try {
    if (myConn) await remove(myConn);
    if (me) {
      await update(ref(rdb, `presence/${me.uid}/meta`), {
        closedBy: "user-quit",
        closedAt: dbNow(),
      });
    }
  } catch { /* the socket closing says the same thing, just less precisely */ }
  window.forge.closeAck();
});

/* =================================================================== boot */

(async function boot() {
  host = await window.forge.hostInfo();
  if (host.googleEnabled) $("googleWrap").style.display = "";

  if (localStorage.getItem(CONSENT_KEY) !== "1") {
    show("scConsent");
    await new Promise((resolve) => {
      $("consentYes").onclick = () => {
        try { localStorage.setItem(CONSENT_KEY, "1"); } catch { /* still fine for this run */ }
        resolve();
      };
      $("consentNo").onclick = () => window.forge.quit();
    });
  }

  await gatePermissions();
  wireAuth();
})();
