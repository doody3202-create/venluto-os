import type { Metadata } from "next";
import "./globals.css";
import "./royal.css";

export const metadata: Metadata = {
  title: "Venluto OS",
  description: "Daily outbound operations, replies, meetings and integration health.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
