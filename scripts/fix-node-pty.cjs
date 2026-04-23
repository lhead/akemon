const fs = require("fs");
const path = require("path");

// node-pty ships prebuilt `spawn-helper` binaries per platform. Some
// npm/tar/filesystem combinations strip the execute bit during install, which
// causes `posix_spawnp failed` at runtime. Restore +x for every prebuild.
try {
  const prebuildsDir = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds");
  if (!fs.existsSync(prebuildsDir)) process.exit(0);

  for (const platformDir of fs.readdirSync(prebuildsDir)) {
    const helper = path.join(prebuildsDir, platformDir, "spawn-helper");
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  }
} catch (e) {
  console.error("[akemon] fix-node-pty:", e.message);
}
