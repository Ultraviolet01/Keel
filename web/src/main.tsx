import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Landing from "./Landing";
import "./styles.css";

// The landing page lives at "/", the app at "/app".
const isApp = window.location.pathname.startsWith("/app");

createRoot(document.getElementById("root")!).render(<StrictMode>{isApp ? <App /> : <Landing />}</StrictMode>);
