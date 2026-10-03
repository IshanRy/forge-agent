# The Forge Agent

A small macOS app participants run for the duration of the hackathon. It
reports what is on their screen at the level of window titles, keeps the last
minute of their screen recorded **on their own machine**, and stays connected
to the organisers' dashboard so a closed app is visible immediately.

It does not decide anything. There are no automated penalties, no scores and no
verdicts anywhere in this code — it reports raw state and an organiser looks at
it. That is a deliberate design constraint, not an omission.

---

## What it collects

**Leaves the machine** (to Firebase Realtime Database, readable by organisers):

- Window titles, roughly every 10 seconds, including browser tab titles —
  because that is what browsers put in their title bar. Not page contents, not
  URLs, not keystrokes, not form data.
- Names of running applications. System daemons are filtered out.
- Whether the app is connected, and when it was last heard from.
- The participant's name, email and team.

**Stays on the machine:**

- A rolling screen recording. Three 20-second clips are kept at any moment —
  40 to 60 seconds — and everything older is discarded continuously. It is
  never uploaded. When an organiser pulls it, the clips are written to
  `~/Library/Application Support/The Forge Agent/incidents/<timestamp>/` and a
  single still goes to the dashboard so they know whether to come and look.

Participants see all of this on a consent screen before anything starts.

---

## Running it from source

```bash
cd agent
npm install
npm start
```

`npm run dev` adds `--forge-dev`, which skips screen capture entirely. Useful
for working on the dashboard without burning permission grants.

> Running from source attributes macOS permission prompts to your **terminal**,
> not to the app. The packaged app will ask again from scratch.

---

## Building the DMGs

```bash
npm run dist
```

Produces `dist/TheForgeAgent-arm64.dmg` and `dist/TheForgeAgent-x64.dmg`. Both
are ad-hoc signed (see `scripts/adhoc-sign.js`) and not notarised, so
participants get one Gatekeeper prompt on first launch.

### Getting them to participants

`AGENT_DOWNLOAD` in `../config.js` already points at release assets on
**`IshanRy/forge-agent`** — a separate public repo holding nothing but the
builds. So shipping a new version is just:

1. `npm run dist` (above).
2. On `forge-agent`: **Releases → Draft a new release →** tag it → drag both
   `.dmg` files into the assets box → **Publish**.

The **Download for Mac** buttons on the participant dashboard go live straight
away. The links use `/releases/latest/download/`, which redirects to the newest
release, so `config.js` never needs touching again.

Two things that break this quietly: `forge-agent` going private (release assets
inherit repo visibility, and the link keeps working for you while 404ing for
everyone else — which is exactly why the builds are not on the main repo), and
renaming the output, which is pinned by `artifactName` in `package.json`.
Don't commit the `.dmg` files to either repo; at ~100MB each they are on
GitHub's hard per-file limit.

### Google sign-in (optional)

Participants who signed up with Google have no password, so they cannot use
the email form at all. `signInWithPopup` is not an option — Google refuses
OAuth inside embedded webviews — so the agent does the supported desktop flow
instead: real browser, loopback redirect, PKCE, then hands the resulting
Google ID token to Firebase.

It needs one credential, and stays hidden until it has it:

1. Google Cloud Console → **APIs & Services → Credentials → Create
   credentials → OAuth client ID → Desktop app**. Do this in the **same
   project as Firebase** (`theforge-b77f7`) — Firebase only trusts ID tokens
   whose audience is a client in its own project.
2. Put the client ID and secret into `GOOGLE_OAUTH` at the top of `main.js`.
3. Rebuild.

No redirect URI to register: desktop clients may use any loopback port, and
the agent picks a free one per sign-in. The client secret is not confidential
and Google documents it as such — an installed app cannot keep one — so
shipping it is expected. PKCE is what protects the exchange.

If sign-in returns `auth/invalid-credential`, the OAuth client is in a
different Cloud project than Firebase. That is the only common cause.

### Permissions do not survive a rebuild

An ad-hoc signature has no certificate, so macOS keys the app's privacy grants
to its code hash — which changes on every build. A rebuilt agent looks
perfectly healthy and records **a blank screen**, because a missing Screen
Recording grant is not an error: the capture succeeds and contains nothing.

Two ways to deal with this:

1. **Build once and don't update mid-event.** Simplest, and fine for a weekend.
2. **Sign with a self-signed certificate.** Keychain Access → Certificate
   Assistant → *Create a Certificate…* → name it `The Forge Dev`, Identity Type
   **Self Signed Root**, Certificate Type **Code Signing**. Then set
   `build.mac.identity` in `package.json` to `"The Forge Dev"`. Grants then key
   on the certificate and survive rebuilds. Gatekeeper still treats it as
   unsigned, so participants' first-launch steps do not change.

---

## Installing it — participant instructions

Copy this section to participants verbatim.

1. Open the `.dmg` and **drag The Forge Agent into Applications.** Do not run it
   from the disk image or from Downloads — macOS runs apps from those locations
   at a randomised path, and the permissions you grant will not stick.
2. Double-click it. macOS will say it *"can't be opened because Apple could not
   verify it is free of malware"*. Click **Done**.
3. Go to **System Settings → Privacy & Security**, scroll to the bottom, and
   click **Open Anyway**. Confirm with Touch ID.
   *Right-click → Open no longer works on macOS Sequoia and later.*
4. Grant **Screen & System Audio Recording** when asked, then **quit and reopen
   the app**. macOS does not apply a new screen-recording grant to an app that
   is already running — the agent has a Restart button for this.
5. Approve **"The Forge Agent wants to control System Events"**, and tick the
   app under **Privacy & Security → Accessibility**. This is what reads window
   titles; without it the agent reports running applications only, and the
   dashboard shows that it is switched off.

Faster alternative to steps 2–3, if you are comfortable in a terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/The Forge Agent.app"
```

### While it is running

macOS shows a screen-recording indicator in the menu bar the whole time. That
is expected — it is this app, recording the rolling buffer that stays on your
own machine.

---

## Quitting and uninstalling — after the event

Closing the agent during the hackathon is against the rules. Afterwards:

1. **Quit:** `Cmd-Q`, or The Forge Agent → Quit. Confirm at the prompt.
2. **Delete the app:** drag `/Applications/The Forge Agent.app` to the Bin.
3. **Delete its data**, including any saved clips:

   ```bash
   rm -rf ~/Library/Application\ Support/The\ Forge\ Agent
   ```

4. **Revoke the permissions** — System Settings → Privacy & Security → *Screen
   & System Audio Recording*, *Accessibility* and *Automation*, and remove The
   Forge Agent from each. Or, in one go:

   ```bash
   tccutil reset ScreenCapture dev.theforge.agent
   tccutil reset Accessibility dev.theforge.agent
   tccutil reset AppleEvents   dev.theforge.agent
   ```

Nothing is left behind after those four steps. The agent installs no launch
agent, no login item and no kernel extension, and it never runs unless it is
open.

---

## How it fits together

| File | What it does |
|---|---|
| `main.js` | Window, the `forge://` scheme, screen-capture wiring, permission gating, writing clips to disk, the close confirmation |
| `preload.js` | The entire bridge between the page and the OS |
| `sampler.js` | Window titles via System Events; running apps via `ps` |
| `renderer/index.html` | Consent → permissions → sign-in → status |
| `renderer/app.js` | Firebase auth, presence, the rolling buffer, answering pulls |
| `scripts/adhoc-sign.js` | Ad-hoc signature, without which arm64 builds will not launch |

Organisers watch it at `monitor.html` on the main site. The security rules are
in `../database.rules.json`.

### Notes for whoever maintains this

- `firebaseConfig` in `renderer/app.js` duplicates the one in `../config.js`.
  Change one, change the other.
- The Realtime Database instance is in **asia-southeast1**, and the region is
  part of the host name. Move it and three things have to move with it:
  `databaseURL` here, `databaseURL` in `../config.js`, and both the `https://`
  and `wss://` entries in the `connect-src` line of `renderer/index.html`.
  Forget the last one and the agent fails silently — the WebSocket is blocked
  by the content policy, so it never connects and never explains itself.
  (`Cmd-Opt-I` in the agent shows the CSP violation in the console.)
- The free Spark tier allows **100 simultaneous connections** — every running
  agent plus every open dashboard tab. It refuses new ones at the limit rather
  than queueing. Comfortable to about 80 machines.
- Nothing uses Cloud Storage. It has required the paid Blaze plan since
  February 2026, which is why clips stay on the device.
- Arc hides its window titles, so it reports as empty. Chrome, Safari, Edge and
  Firefox all expose the active tab's title.
