// Ad-hoc code signature, applied after electron-builder packs the app.
//
// Two reasons this exists:
//
//   1. An arm64 app with no signature at all will not launch on Apple
//      Silicon — macOS kills it outright. So "unsigned" in practice means
//      "ad-hoc signed".
//   2. package.json sets identity: null rather than identity: "-", because
//      electron-builder's own ad-hoc path pairs the signature with
//      hardenedRuntime, and that combination silently breaks screen capture
//      (the stream goes live and records nothing). Doing it here, with
//      hardenedRuntime off, avoids that.
//
// An ad-hoc signature has no certificate, so macOS keys the app's privacy
// permissions to its cdhash — which changes on every build. Ship one build
// and don't update mid-event, or sign with a self-signed certificate
// instead (see README.md, "Permissions do not survive a rebuild").

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });
  console.log(`  • ad-hoc signed ${app}`);
};
