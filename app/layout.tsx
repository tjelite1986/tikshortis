import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getSession, handleFor } from "@/lib/auth";
import BottomNav from "@/components/bottom-nav";
import SignedOut from "@/components/signed-out";
import PwaRegister from "@/components/pwa-register";
import InstallBanner from "@/components/install-banner";

export const metadata: Metadata = {
  title: "Tikshortis",
  description: "A vertical short-video library.",
  manifest: "/manifest.webmanifest",
  applicationName: "Tikshortis",
  appleWebApp: {
    capable: true,
    title: "Tikshortis",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/favicon-32.png?v=1",
    apple: "/apple-touch-icon.png?v=1",
  },
};

export const viewport: Viewport = {
  themeColor: "#121212",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Every page needs the session, so it is resolved once here rather than in
// each page.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <html lang="en" className="dark">
      <body className="overflow-x-hidden bg-[#121212]">
        <div
          className="relative min-h-[100dvh] w-full"
          style={{ background: "var(--app-bg)" }}
        >
          {session ? (
            <BottomNav
              isAdmin={session.role === "admin"}
              handle={handleFor({
                username: session.username,
                email: session.email,
              })}
            >
              {children}
              <InstallBanner />
            </BottomNav>
          ) : (
            // Not a redirect: the form signs the visitor in on the page they
            // opened, so a shared link survives the sign-in.
            <SignedOut />
          )}
        </div>
        <PwaRegister />
      </body>
    </html>
  );
}
