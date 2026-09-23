import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PostgreSQL EXPLAIN Visualiser",
  description:
    "Interactive React Flow visualiser for PostgreSQL EXPLAIN (FORMAT JSON) plans",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
