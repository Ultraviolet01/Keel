import { loadFont as loadSerif } from "@remotion/google-fonts/Fraunces";
import { loadFont as loadSans } from "@remotion/google-fonts/HankenGrotesk";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";

// The site's own type and colours, so the video looks like Keel.
export const serif = loadSerif("normal", { weights: ["500", "600"], subsets: ["latin"] }).fontFamily;
export const sans = loadSans("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

export const C = {
  deep: "#071013",
  page: "#0b1416",
  surface: "#121e21",
  line: "#1f2f31",
  line2: "#2d4143",
  ink: "#e4eeed",
  ink2: "#b0c2c2",
  muted: "#8ea2a3",
  teal: "#2e9a8b",
  teal2: "#3bb3a2",
  tealTint: "#12302c",
  brass: "#d9a74c",
  brassTint: "#2a2315",
  bad: "#e06c5a",
  badTint: "#331a16",
};
