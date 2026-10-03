// What the agent knows about the machine it is running on: the titles of the
// open windows, and which applications are running.
//
// Both are deliberately shallow. There are no browser extensions, no proxy,
// no reading of page contents or URLs — a window title is whatever the app
// chose to put in its title bar, which for every mainstream browser happens
// to be the active tab's page title.
//
// Nothing here decides anything. It returns raw strings; the admin dashboard
// is what matches them against a watchlist.

const { execFile } = require("node:child_process");

const EXEC_TIMEOUT_MS = 6000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ err, stdout: stdout || "" })
    );
  });
}

/* ------------------------------------------------------------------
   Window titles, via System Events.

   "with timeout of 3 seconds" is not optional: the default Apple Event
   timeout is two minutes, so a single beachballing app would otherwise
   wedge the sampler for that long and take the heartbeat down with it.

   Every inner loop is wrapped in try/end try because a window can close
   between being listed and being read, and one such error aborts the whole
   script.
   ------------------------------------------------------------------ */
const WINDOWS_SCRIPT = `
with timeout of 3 seconds
  set frontApp to ""
  set frontTitle to ""
  set out to {}
  tell application "System Events"
    try
      set fp to first application process whose frontmost is true
      set frontApp to name of fp
      try
        set frontTitle to name of front window of fp
      end try
    end try
    repeat with p in (every application process whose background only is false)
      try
        set pn to name of p
        repeat with w in (every window of p)
          try
            set wn to name of w
            if wn is not missing value and wn is not "" then
              set end of out to pn & tab & wn
            end if
          end try
        end repeat
      end try
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return frontApp & tab & frontTitle & linefeed & "##" & linefeed & (out as text)
end timeout
`;

const MAX_WINDOWS = 60;
const MAX_LEN = 400;

function clamp(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Open window titles, as "App<TAB>Title" strings, plus whichever is in front.
 *
 * `ok: false` means macOS refused rather than that nothing is open — almost
 * always a missing Accessibility grant (AppleScript error -1719) or a
 * missing Automation grant (-1743). The dashboard renders that state as
 * "titles unavailable" rather than as an empty desk, because the two mean
 * very different things when you are deciding whether someone cheated.
 */
async function windowTitles() {
  const { err, stdout } = await run("osascript", ["-e", WINDOWS_SCRIPT]);
  if (err) {
    const msg = String(err.message || "");
    const denied = msg.includes("-1719") || msg.includes("-1743") ||
      /not allowed|assistive|Not authorized/i.test(msg);
    return { ok: false, denied, frontApp: "", frontTitle: "", windows: [] };
  }

  const [head, ...rest] = stdout.split("\n##\n");
  const [frontApp = "", frontTitle = ""] = head.split("\t");

  const windows = (rest.join("\n##\n") || "")
    .split("\n")
    .map((l) => clamp(l.replace(/\t/g, " — "), MAX_LEN))
    .filter(Boolean)
    .slice(0, MAX_WINDOWS);

  return {
    ok: true,
    denied: false,
    frontApp: clamp(frontApp, 120),
    frontTitle: clamp(frontTitle, MAX_LEN),
    windows,
  };
}

/* ------------------------------------------------------------------
   Running applications.

   Raw `ps -axo comm=` is about 90% system daemons, which is noise that
   costs bandwidth and tells an organiser nothing. So this keeps only two
   kinds of thing: real application bundles, and binaries installed in the
   places a person installs software (Homebrew, /usr/local, MacPorts).

   Chromium and Electron apps spawn a dozen "… Helper" processes each; those
   are folded away, since the parent app is already in the list.
   ------------------------------------------------------------------ */
const APP_BUNDLE = /\/([^/]+)\.app\/Contents\/MacOS\//;
const USER_BIN = /^\/(opt\/homebrew|usr\/local|opt\/local)\/(s?bin|Cellar)\//;
const HELPER = /\s(Helper|Web Content|Renderer|GPU|Plugin|Crashpad|Network|Notification)\b/i;
const MAX_PROCESSES = 80;

async function processes() {
  const { err, stdout } = await run("ps", ["-axo", "comm="]);
  if (err) return { ok: false, processes: [] };

  const seen = new Set();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const bundle = line.match(APP_BUNDLE);
    let name = null;
    if (bundle) name = bundle[1];
    else if (USER_BIN.test(line)) name = line.split("/").pop();
    if (!name || HELPER.test(name)) continue;

    seen.add(clamp(name, 120));
    if (seen.size >= MAX_PROCESSES * 2) break;
  }

  return {
    ok: true,
    processes: [...seen].sort((a, b) => a.localeCompare(b)).slice(0, MAX_PROCESSES),
  };
}

/** One full sample. Never throws — a failed half is reported, not fatal. */
async function sample() {
  const [w, p] = await Promise.all([windowTitles(), processes()]);
  return {
    frontApp: w.frontApp,
    frontTitle: w.frontTitle,
    windows: w.windows,
    processes: p.processes,
    titlesOk: w.ok,
    titlesDenied: w.denied,
  };
}

module.exports = { sample, windowTitles, processes };
