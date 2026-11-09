// Joins the rendered video and the score into the MP4 posted on X
// (H.264 High, yuv420p, AAC, fast start). Run after `npm run sound` and `npm run render`.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const video = "out/keel-raw.mp4";
const audio = "public/audio/score.wav";
const missing = [
  [video, "npm run render"],
  [audio, "npm run sound (needs Python with numpy, scipy and pyloudnorm)"],
].filter(([f]) => !existsSync(f));
if (missing.length) {
  for (const [f, how] of missing) console.error(`Missing ${f}: run ${how} first.`);
  console.error("Or run everything in order with: npm run video");
  process.exit(1);
}
const r = spawnSync(
  "ffmpeg",
  ["-y", "-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "out/keel-demo.mp4"],
  { stdio: "inherit" },
);
if (r.error) {
  console.error("ffmpeg is not installed or not on PATH: install it from https://ffmpeg.org and try again.");
  process.exit(1);
}
if (r.status === 0) console.log("Wrote out/keel-demo.mp4");
process.exit(r.status ?? 1);
