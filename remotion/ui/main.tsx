import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Could not find the #root element in index.html.");
}

createRoot(container).render(<App />);
