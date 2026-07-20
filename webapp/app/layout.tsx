import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Search HQ",
  description: "The human surface for the family job-search system",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
