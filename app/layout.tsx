import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getSession, handleFor } from "@/lib/auth";
import { loginUrl, ssoConfigured } from "@/lib/sso";
import BottomNav from "@/components/bottom-nav";
import SignedOut from "@/components/signed-out";

export const metadata: Metadata = {
  title: "Tikshortis",
  description: "A vertical short-video library.",
  applicationName: "Tikshortis",
  appleWebApp: {
    capable: true,
    title: "Tikshortis",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#121212",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Every page needs the session, and the session comes from a network call to
// elite-v2 — so it is resolved once here rather than in each page.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const eliteUrl = process.env.ELITE_APP_URL || null;

  // Two custom properties, adopted from the site the login comes from so the
  // app does not announce itself as somewhere else on every visit. Both values
  // are re-validated in lib/sso.ts before they reach this style block; signed
  // out, the defaults in globals.css stand.
  const appearance = session?.appearance;
  const themeCss = appearance
    ? `:root{--accent:${appearance.accent};--app-bg:${appearance.bg}}`
    : "";

  return (
    <html lang="en" className="dark">
      <body className="overflow-x-hidden bg-[#121212]">
        {themeCss && <style dangerouslySetInnerHTML={{ __html: themeCss }} />}
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
              eliteUrl={eliteUrl}
            >
              {children}
            </BottomNav>
          ) : (
            // Not a redirect. The sign-in page belongs to another host, and a
            // server-side redirect there would make every cold load bounce
            // through it — including the ones where elite-v2 is simply
            // unreachable, which is a different problem and deserves to say so.
            <SignedOut
              loginHref={loginUrl("/")}
              configured={ssoConfigured()}
            />
          )}
        </div>
      </body>
    </html>
  );
}
