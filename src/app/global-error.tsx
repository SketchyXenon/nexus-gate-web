"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

// Global error boundary — catches errors that error.tsx can't
// (e.g., errors in the root layout itself).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", backgroundColor: "#fffef7" }}>
          <div style={{ maxWidth: "400px", width: "100%", textAlign: "center" }}>
            <div style={{ width: "56px", height: "56px", borderRadius: "50%", backgroundColor: "rgba(220,38,38,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <AlertTriangle style={{ width: "28px", height: "28px", color: "#dc2626" }} />
            </div>
            <h1 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "4px", fontFamily: "monospace" }}>
              Critical error
            </h1>
            <p style={{ fontSize: "14px", color: "#737373", marginBottom: "16px" }}>
              The application encountered a fatal error. Please refresh the page.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "10px 20px",
                borderRadius: "8px",
                border: "1px solid #e5e5e5",
                backgroundColor: "#b45309",
                color: "white",
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <RotateCcw style={{ width: "16px", height: "16px" }} />
              Refresh page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
