import { useEffect, useState } from "react";

/**
 * Step 0 scaffold check.
 *
 * This deliberately verifies the three things the whole UI architecture rests
 * on, before any real screens are built:
 *   1. React renders through Vite.
 *   2. /api reaches the Phase 2B server through the dev proxy (same origin).
 *   3. public/ is served at the web root, so staticFile() paths resolve — which
 *      is what makes the <Player> preview possible later.
 *
 * Replaced by the real app shell in the next step.
 */
export const App: React.FC = () => {
  const [health, setHealth] = useState<string>("checking…");
  const [trackCount, setTrackCount] = useState<string>("checking…");

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((body) => setHealth(JSON.stringify(body)))
      .catch((error: Error) => setHealth(`failed: ${error.message}`));

    fetch("/api/tracks")
      .then((response) => response.json())
      .then((body) => setTrackCount(JSON.stringify(body.data)))
      .catch((error: Error) => setTrackCount(`failed: ${error.message}`));
  }, []);

  return (
    <div
      style={{
        background: "#0b0b0b",
        color: "#f4e8d0",
        minHeight: "100vh",
        padding: 32,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ color: "#b8860b" }}>Toshi Visualizer — scaffold check</h1>

      <p>
        <strong>API health:</strong> {health}
      </p>
      <p>
        <strong>Tracks:</strong> {trackCount}
      </p>

      <p>
        <strong>public/ asset (cover.png via staticFile-style path):</strong>
      </p>
      <img
        src="/tracks/ghetto-geek/cover.png"
        alt="Ghetto Geek cover"
        width={200}
        style={{ border: "2px solid #b8860b", borderRadius: 8 }}
      />
    </div>
  );
};
