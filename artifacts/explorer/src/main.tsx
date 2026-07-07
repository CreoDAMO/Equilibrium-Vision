import { setBaseUrl } from "@workspace/api-client-react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Restore the API base URL from localStorage so all calls go to the right
// server even before the React tree mounts (avoids a flash of wrong-network data).
try {
  const stored = localStorage.getItem("equ_network");
  if (stored) {
    const { url } = JSON.parse(stored) as { name: string; url: string };
    setBaseUrl(url || null); // empty string = same-origin, so clear the override
  }
} catch {
  // Corrupted storage — ignore and use same-origin default
}

createRoot(document.getElementById("root")!).render(<App />);
