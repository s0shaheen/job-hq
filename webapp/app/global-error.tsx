"use client";

/**
 * Last resort: an error in the root layout itself, where no shell and no
 * styling survive. It must therefore be self-contained — inline styles only,
 * no imports that could be the very thing that failed.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100dvh",
          margin: 0,
          background: "#fbfbfa",
          color: "#1a1a18",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: "26rem" }}>
          <h1 style={{ fontSize: "1.1rem", margin: 0 }}>Job Search HQ couldn't start</h1>
          <p style={{ fontSize: "0.85rem", color: "#78786f", marginTop: "0.5rem" }}>
            This is a fault on our side. Your data is untouched.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1.25rem",
              padding: "0.5rem 1rem",
              borderRadius: 6,
              border: "1px solid #d4d4cf",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
