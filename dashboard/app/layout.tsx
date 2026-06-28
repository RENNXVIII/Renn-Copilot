import type { Metadata } from "next";
import NextTopLoader from "nextjs-toploader";
import { SidebarNav } from "@/components/sidebar-nav";
import { ToastProvider } from "@/components/ui/toast";
import { CommandPalette } from "@/components/command-palette";
import "./globals.css";

export const metadata: Metadata = {
  title: "Renn Copilot",
  description: "Configure CLIProxyAPI providers and sync models into GitHub Copilot Chat.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <NextTopLoader color="#6366f1" showSpinner={false} height={2} />
        <ToastProvider>
          <div className="flex min-h-screen">
            <SidebarNav />
            <main className="flex-1 p-6 md:p-8">{children}</main>
          </div>
          <CommandPalette />
        </ToastProvider>
      </body>
    </html>
  );
}
