import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Docs from "./Docs";
import { HowItWorks, Security } from "./guide";
import Landing from "./Landing";
import "./styles.css";
import { applySavedTheme } from "./theme";

applySavedTheme();

// "/" is the landing page and "/app" the app; the guide pages have their own paths.
const path = window.location.pathname.replace(/\/+$/, "");
const Page = path.startsWith("/app") ? App : path === "/docs" ? Docs : path === "/how-it-works" ? HowItWorks : path === "/security" ? Security : Landing;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
