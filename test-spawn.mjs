// Minimal test: can Node spawn claude --print?
import { spawn } from "child_process";

const task = "用中文解释什么是MCP协议，三句话以内";
console.log(`Spawning: claude --print "${task}"`);
console.log("---");

const child = spawn("claude", ["--print", "--verbose", task], {
  env: {
    ...process.env,
    CLAUDECODE: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(`[stdout] ${chunk}`);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[stderr] ${chunk}`);
});

child.on("close", (code, signal) => {
  console.log(`\n--- exit code=${code} signal=${signal}`);
});

child.on("error", (err) => {
  console.error("spawn error:", err);
});
