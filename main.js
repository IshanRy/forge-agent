// The Forge Agent — main process.
//
// Holds the window, owns everything that needs OS access (screen capture
// permission, window titles, writing clips to disk), and hands the renderer
// a narrow bridge to it. The renderer does the Firebase half: sign-in,
// presence, and the rolling screen buffer.

const {
  app, protocol, net, session, screen, shell, dialog, powerMonitor,
  BrowserWindow, desktopCapturer, systemPreferences, ipcMain,
} = require("electron");

const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const sampler = require("./sampler");

const DEV = process.argv.includes("--forge-dev");
const RENDERER_DIR = path.join(__dirname, "renderer");
const INCIDENTS_DIR = path.join(app.getPath("userData"), "incidents");

/* ------------------------------------------------------------------
   Google sign-in.

   signInWithPopup does not work here and cannot be made to: Google refuses
   OAuth inside embedded webviews. The supported route for a desktop app is
   RFC 8252 — open the real browser, catch the redirect on a loopback
   server, exchange the code for an ID token, and hand that to Firebase.

   Fill these in from Google Cloud Console -> APIs & Services ->
   Credentials -> Create credentials -> OAuth client ID -> **Desktop app**,
   inside the same project as Firebase (theforge-b77f7), or the ID token's
   audience will not be one Firebase trusts. No redirect URI to register:
   desktop clients may use any loopback port.

   The client secret is not a secret here, and Google says so — an installed
   app cannot keep one. PKCE is what actually protects the exchange.

   Left empty, the button stays hidden and email/password still works.
   ------------------------------------------------------------------ */
// Written into oauth.json at build time from the repo's GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET Actions secrets, so they stay out of this public repo.
const GOOGLE_OAUTH = (() => {
  try { return require("./oauth.json"); }
  catch { return { clientId: "", clientSecret: "" }; }
})();

/* ------------------------------------------------------------------
   While frozen: the window cannot be minimised, and if it is hidden or
   loses focus anyway (Cmd-Tab, Mission Control, another Space) it is pulled
   back. Each time that happens is counted, and so is every second of
   keyboard or mouse input while the freeze screen was not in front —
   macOS's system idle timer gives that without any permission. Both go to
   the dashboard as plain numbers; what they mean is the organisers' call.
   ------------------------------------------------------------------ */
let frozen = false, freezeWatch = null, awayFlag = false;

function pullBack() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true, "screen-saver");
  win.setFullScreen(true);
  win.focus();
}

function watchFreeze() {
  if (!frozen || !win || win.isDestroyed()) return;
  const away = win.isMinimized() || !win.isVisible() || !win.isFocused();
  const active = away && powerMonitor.getSystemIdleTime() <= 1;
  if (away && !awayFlag) win.webContents.send("freeze:left");
  if (active) win.webContents.send("freeze:active");
  awayFlag = away;
  if (away) pullBack();
}

const OAUTH_TIMEOUT_MS = 180_000;
let oauthInFlight = false;

/* ------------------------------------------------------------------
   Why a custom scheme instead of loading the renderer over file://

   file:// is an opaque origin in Chromium: IndexedDB is unavailable and
   localStorage is unreliable. Firebase Auth quietly falls back to in-memory
   persistence there, which means every participant retypes their password
   on every launch — and you don't find out until the morning of the event.
   Declaring "forge" as standard + secure gives the renderer a real origin,
   so storage, CSP and crypto behave exactly as they do on the website.

   The scheme name is part of the origin, so renaming it later would orphan
   everyone's stored session. It is fixed.
   ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "forge",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// One instance only. A second copy would open a second RTDB connection and
// show up on the dashboard as a duplicate of the same person.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let closeAck = null;

/* ------------------------------------------------------------------ window */

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#000000",
    title: "The Forge Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.maximize();
  win.loadURL("forge://app/index.html");

  // Every capture and every heartbeat lives in the renderer. If it dies the
  // main process carries on none the wiser, so presence would keep saying
  // "online" over a window that is recording nothing. Reload instead.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("renderer gone:", details.reason);
    if (!win.isDestroyed()) win.reload();
  });

  win.on("closed", () => { win = null; });
  wireCloseConfirm();
}

/* ------------------------------------------------------------------
   Closing.

   Participants are told up front that closing the agent is against the
   rules. The app says so again here — and then lets them do it. Refusing to
   quit would make this something people are right to be angry about, and
   the rules already cover the consequence: an organiser decides, manually.

   Before the window actually goes, the renderer gets a moment to record
   that this was a deliberate quit rather than a crash or a kill, so the
   dashboard can tell the difference.
   ------------------------------------------------------------------ */
function wireCloseConfirm() {
  let allowClose = false;

  win.on("close", async (e) => {
    if (allowClose) return;
    e.preventDefault();

    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Keep it running", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      message: "Closing the agent is against the hackathon rules.",
      detail:
        "Your team will show as disconnected on the organisers' dashboard " +
        "straight away, with the time you closed it.\n\n" +
        "Whether that counts against you is decided by an organiser, not by " +
        "this app.",
    });

    if (response !== 1) return;

    if (win && !win.isDestroyed()) {
      const acked = new Promise((resolve) => { closeAck = resolve; });
      win.webContents.send("agent:closing");
      await Promise.race([acked, new Promise((r) => setTimeout(r, 2500))]);
      closeAck = null;
    }

    allowClose = true;
    if (win && !win.isDestroyed()) win.close();
  });
}

/* --------------------------------------------------------- permissions */

/**
 * Screen Recording state.
 *
 * Two macOS quirks make this more than a one-liner:
 *
 *   - getMediaAccessStatus("screen") is read-only. It never prompts, and it
 *     never registers the binary with TCC, so until something actually
 *     attempts a capture the app does not even appear in the System
 *     Settings list for the participant to tick. A 1x1 getSources() call is
 *     what puts it there.
 *   - the answer is cached for the life of the process, and macOS does not
 *     apply a new screen grant to an already-running app anyway. Once it is
 *     granted, the agent has to be relaunched. There is no way around that.
 */
async function screenStatus({ prime = false } = {}) {
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (prime && status !== "granted") {
    try {
      await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
    } catch { /* the attempt is the point; the result is not */ }
  }
  return status;
}

const SETTINGS_URL = {
  screen:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

/* --------------------------------------------------------- google oauth */

function donePage(ok, detail) {
  const line = ok
    ? "You're signed in. Go back to The Forge Agent."
    : `Sign-in didn't complete${detail ? ` — ${detail}` : ""}. Go back to the app and try again.`;
  return `<!doctype html><meta charset="utf-8"><title>The Forge</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#000;color:#efe9e1;font:300 15px/1.5 -apple-system,Helvetica,Arial,sans-serif">
<p style="max-width:34ch;text-align:center;padding:24px">${line}</p>`;
}

/** Loopback listener for the redirect. Started before the browser opens, so
    the port is known in time to go in the redirect URI. */
function startLoopback(state) {
  let settle, fail;
  const code = new Promise((res, rej) => { settle = res; fail = rej; });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const got = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (!got && !err) { res.writeHead(404).end(); return; }   // favicon, etc

    const stateOk = url.searchParams.get("state") === state;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(donePage(!err && stateOk, err || (stateOk ? "" : "state mismatch")));

    if (err) fail(new Error(err));
    else if (!stateOk) fail(new Error("state mismatch"));
    else settle(got);
  });

  const ready = new Promise((res, rej) => {
    server.once("error", rej);
    // 127.0.0.1 explicitly, and port 0 so the OS picks a free one.
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });

  return { ready, code, close: () => { try { server.close(); } catch {} } };
}

async function googleSignIn() {
  if (!GOOGLE_OAUTH.clientId) return { error: "not-configured" };
  if (oauthInFlight) return { error: "A sign-in is already open in your browser." };
  oauthInFlight = true;

  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  let lb = null;

  try {
    lb = startLoopback(state);
    const redirectUri = `http://127.0.0.1:${await lb.ready}`;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.search = new URLSearchParams({
      client_id: GOOGLE_OAUTH.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      // so somebody already signed into a personal account can pick the
      // one they actually signed up to the hackathon with
      prompt: "select_account",
    }).toString();

    await shell.openExternal(authUrl.toString());

    const code = await Promise.race([
      lb.code,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timed out waiting for the browser")), OAUTH_TIMEOUT_MS)),
    ]);

    const resp = await net.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_OAUTH.clientId,
        client_secret: GOOGLE_OAUTH.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.id_token) {
      return { error: json.error_description || json.error || `token exchange failed (${resp.status})` };
    }
    return { idToken: json.id_token };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (lb) lb.close();
    oauthInFlight = false;
  }
}

/* ------------------------------------------------------------------ ipc */

function registerIpc() {
  ipcMain.handle("host:info", () => ({
    host: os.hostname().replace(/\.local$/, ""),
    displayCount: screen.getAllDisplays().length,
    version: app.getVersion(),
    dev: DEV,
    incidentsDir: INCIDENTS_DIR,
    googleEnabled: !!GOOGLE_OAUTH.clientId,
  }));

  ipcMain.handle("auth:google", googleSignIn);

  ipcMain.handle("perm:check", async (_e, { prime = false } = {}) => ({
    screen: await screenStatus({ prime }),
    // false here is "not granted yet", checked without throwing a dialog at
    // someone who is in the middle of something.
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  }));

  // The only call that shows the Accessibility dialog. It does not grant
  // anything — macOS only ever offers a shortcut to System Settings — but it
  // is how the app gets listed there.
  ipcMain.handle("perm:prompt-accessibility", () =>
    systemPreferences.isTrustedAccessibilityClient(true)
  );

  ipcMain.handle("perm:open", (_e, which) => {
    const url = SETTINGS_URL[which];
    if (url) shell.openExternal(url);
  });

  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // Declining the consent screen, or backing out at the permissions step.
  // Neither is "closing the agent during the hackathon", so neither gets the
  // dialog that says so.
  ipcMain.handle("app:quit", () => app.exit(0));

  /* Freeze. A fullscreen always-on-top window over everything, not an OS
     lock — the agent cannot take one and should not try. Someone determined
     can still quit the app, which is already against the rules and already
     shows on the dashboard. This is a "stop, now" that an organiser can send
     from across the room, not a cage. */
  ipcMain.handle("freeze:set", (_e, on) => {
    if (!win || win.isDestroyed()) return;
    frozen = on;
    win.setMinimizable(!on);
    if (on) {
      pullBack();
      clearInterval(freezeWatch);
      freezeWatch = setInterval(watchFreeze, 1000);
    } else {
      clearInterval(freezeWatch);
      awayFlag = false;
      win.setFullScreen(false);
      win.setAlwaysOnTop(false);
    }
  });

  ipcMain.handle("sample:now", () => sampler.sample());

  ipcMain.handle("agent:close-ack", () => { if (closeAck) closeAck(); });

  ipcMain.handle("shell:reveal", async () => {
    await fs.mkdir(INCIDENTS_DIR, { recursive: true });
    shell.openPath(INCIDENTS_DIR);
  });

  /**
   * A single still of the screen, as base64 JPEG.
   *
   * Clips stay on disk, so without this an organiser who pulls a buffer has
   * to walk over to the machine before they know whether it was worth
   * pulling. A ~50KB still costs nothing, goes straight to the dashboard,
   * and answers that question immediately.
   */
  ipcMain.handle("screen:poster", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 800, height: 500 },
        fetchWindowIcons: false,
      });
      const shot = sources[0] && sources[0].thumbnail;
      if (!shot || shot.isEmpty()) return null;
      return shot.toJPEG(55).toString("base64");
    } catch {
      return null;
    }
  });

  /**
   * Write the pulled segments to disk.
   *
   * Under userData (~/Library/Application Support/The Forge Agent), not the
   * home folder: writing into Documents or Desktop trips extra privacy
   * prompts on recent macOS, and dropping files into somebody's home
   * uninvited reads as hostile even when it isn't.
   */
  ipcMain.handle("clips:save", async (_e, { stamp, files }) => {
    const folder = path.join(INCIDENTS_DIR, stamp);
    await fs.mkdir(folder, { recursive: true });

    const written = [];
    for (const f of files) {
      const safe = path.basename(String(f.name));
      const buf = Buffer.from(f.data);
      await fs.writeFile(path.join(folder, safe), buf);
      written.push({ name: safe, bytes: buf.length, ms: Number(f.ms) || 0 });
    }
    return { folder, files: written };
  });
}

/* ---------------------------------------------------------------- start */

app.whenReady().then(() => {
  protocol.handle("forge", (request) => {
    const { pathname } = new URL(request.url);
    const file = path.join(RENDERER_DIR, decodeURIComponent(pathname));
    // path.join normalises "..", so this catches an escape attempt before
    // the scheme turns into an arbitrary file reader.
    if (!file.startsWith(RENDERER_DIR)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  /* Screen capture without a picker.
     - useSystemPicker is pinned false: when it is on, macOS shows its own
       sharing dialog and this handler is never called at all.
     - there is no `audio: false` — the key takes a Session or a frame, and
       the way to ask for no audio is to leave it out.
     - callback() with no arguments is the deny path. */
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!sources.length) return callback();

        const primary = String(screen.getPrimaryDisplay().id);
        const pick = sources.find((s) => s.display_id === primary) || sources[0];
        callback({ video: pick });
      } catch {
        callback();
      }
    },
    { useSystemPicker: false }
  );

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// Quitting is the participant's decision and the window close is where it is
// confirmed. Nothing here relaunches or resists it.
app.on("window-all-closed", () => app.quit());
