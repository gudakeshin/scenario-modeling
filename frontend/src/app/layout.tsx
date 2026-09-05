import type { Metadata } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Scenario Modeling | Deloitte",
  description: "AI-powered P&L scenario modeling and business analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before paint to avoid a flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <ErrorBoundary>{children}</ErrorBoundary>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--card-bg)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
            },
          }}
        />
      </body>
    </html>
  );
}
