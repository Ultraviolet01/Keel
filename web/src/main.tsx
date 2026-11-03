import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Docs from "./Docs";
import Landing from "./Landing";
import "./styles.css";

// The landing page lives at "/", the app at "/app", the guide at "/docs".
const path = window.location.pathname;
const Page = path.startsWith("/app") ? App : path.startsWith("/docs") ? Docs : Landing;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
