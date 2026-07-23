import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { joinBytes, joinFromChunk } from "./erasureJoiner.js";
import { resolvePlaylist, parseWatchUrl, feedTopicHex } from "./swarmFeed.js";

// Expose helpers for console debugging / testing during the POC.
if (typeof window !== "undefined") {
  window.__swarm = { joinBytes, joinFromChunk, resolvePlaylist, parseWatchUrl, feedTopicHex };
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
