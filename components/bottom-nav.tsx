"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Play,
  Compass,
  Users,
  ListVideo,
  Menu,
  Hash,
  Sparkles,
  Clapperboard,
  Upload,
  Download,
  Settings,
  ArrowLeft,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBackDismiss } from "@/lib/use-back-dismiss";

// The four tabs, plus a Menu button for everything that does not earn a tab.
// elite-v2 carried these in its own global bar; standing alone, the app has to
// draw its own — and this is the whole of it, rather than a copy of a 700-line
// context-sensitive menu that would have published another site's structure.
const TABS = [
  { label: "Videos", href: "/", icon: Play },
  { label: "Explore", href: "/explore", icon: Compass },
  { label: "Profiles", href: "/profiles", icon: Users },
  { label: "Playlists", href: "/playlists", icon: ListVideo },
] as const;

interface MenuLink {
  label: string;
  href: string;
  icon: typeof Hash;
  external?: boolean;
}

export default function BottomNav({
  isAdmin = false,
  handle,
  eliteUrl,
  children,
}: {
  isAdmin?: boolean;
  handle: string;
  /** Where the login comes from — the door back to it. Absent when unset. */
  eliteUrl?: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the sheet when a menu link navigates away.
  useEffect(() => setMenuOpen(false), [pathname]);
  useBackDismiss(menuOpen, () => setMenuOpen(false));

  // Longest prefix wins, so /profiles does not light up on /profile/12.
  const activeHref =
    [...TABS]
      .map((t) => t.href)
      .filter((h) => (h === "/" ? pathname === "/" : pathname.startsWith(h)))
      .sort((a, b) => b.length - a.length)[0] ?? null;

  const links: MenuLink[] = [
    { label: "Categories", href: "/tags", icon: Hash },
    { label: "Analysis", href: "/analysis", icon: Sparkles },
    { label: "Mine", href: "/mine", icon: Clapperboard },
    { label: "Upload", href: "/upload", icon: Upload },
    ...(isAdmin
      ? [
          { label: "Grab", href: "/grab", icon: Download },
          { label: "Settings", href: "/settings", icon: Settings },
        ]
      : []),
  ];

  // The immersive feed is exactly one viewport tall; bottom padding under it
  // would only add a dead scroll gap.
  const fullBleed = pathname === "/";

  return (
    <>
      <div
        className={cn(
          "pt-[env(safe-area-inset-top)]",
          !fullBleed && "pb-[calc(3.5rem+env(safe-area-inset-bottom))]"
        )}
      >
        {children}
      </div>

      {/* z-40: below every fullscreen overlay (the sheets are z-50+) so they
          cover the bar; hidden during immersive playback by the
          body.shorts-immersive rule in globals.css. */}
      <nav
        data-immersive-hide
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-white/10 bg-black/60 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        {TABS.map(({ label, href, icon: Icon }) => {
          const active = !menuOpen && href === activeHref;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition",
                active ? "text-rose-400" : "text-white/50 hover:text-white/80"
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.4 : 2} />
              {label}
            </Link>
          );
        })}
        <button
          onClick={() => setMenuOpen(true)}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition",
            menuOpen ? "text-rose-400" : "text-white/50 hover:text-white/80"
          )}
        >
          <Menu size={22} strokeWidth={menuOpen ? 2.4 : 2} />
          Menu
        </button>
      </nav>

      {menuOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="rounded-t-2xl bg-neutral-900 pb-[env(safe-area-inset-bottom)] text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="font-semibold">@{handle}</span>
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu">
                <X size={20} />
              </button>
            </div>
            <div className="py-1">
              {links.map(({ label, href, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-3 px-5 py-3 text-sm transition hover:bg-white/5"
                >
                  <Icon size={18} className="text-white/60" />
                  {label}
                </Link>
              ))}
              {eliteUrl && (
                <>
                  <div className="my-1 border-t border-white/10" />
                  {/* A plain <a>: this address is not one of this app's routes,
                      and asking the router to resolve it would 404 here before
                      the browser ever left. */}
                  <a
                    href={eliteUrl}
                    className="flex items-center gap-3 px-5 py-3 text-sm transition hover:bg-white/5"
                  >
                    <ArrowLeft size={18} className="text-white/60" />
                    Back to Elite
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
