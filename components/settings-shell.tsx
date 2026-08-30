"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { cn } from "@/lib/utils";
import ShortsAdmin from "@/components/shorts-admin";
import ShortsMergeProfiles from "@/components/shorts-merge-profiles";
import ShortsImportButton from "@/components/shorts-import-button";
import ShortsDuplicates from "@/components/shorts-duplicates";
import ShortsCleanup from "@/components/shorts-cleanup";
import ShortsTitleFetch from "@/components/shorts-title-fetch";
import ShortsCaptionBackfill from "@/components/shorts-caption-backfill";

const TABS = [
  { key: "sources", label: "Sources", adminOnly: true },
  { key: "import", label: "Import", adminOnly: false },
  { key: "duplicates", label: "Duplicates", adminOnly: false },
  { key: "cleaning", label: "Cleaning", adminOnly: false },
  { key: "titles", label: "Titles", adminOnly: true },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
      {children}
    </section>
  );
}

function Panel({ tab, isAdmin }: { tab: TabKey; isAdmin: boolean }) {
  if (tab === "sources") {
    return (
      <div className="flex flex-col gap-6">
        <ShortsAdmin />
        <ShortsMergeProfiles />
      </div>
    );
  }
  if (tab === "import") {
    return (
      <Card>
        <h2 className="text-base font-medium">Shared creator folder</h2>
        <p className="mb-2 mt-1 text-sm text-white/50">
          Drop files here, then sort them in:
        </p>
        <code className="mb-2 block rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70">
          shorts/main/_import/
        </code>
        <p className="mb-3 text-sm text-white/50">
          Name a file{" "}
          <code className="text-white/70">title [h_tag][f_profile].mp4</code> —{" "}
          <code className="text-white/70">[f_profile]</code> sets the creator
          profile and <code className="text-white/70">[h_tag]</code> adds
          hashtags. A subfolder named after the creator (or the legacy{" "}
          <code className="text-white/70">profile_-_title</code>) still works.
        </p>
        <p className="mb-3 text-sm text-white/50">
          A dropped file is picked up within five minutes on its own, and is
          playable a few minutes after that — the transcoder runs separately.
          The button is only for when you do not want to wait.
        </p>
        {isAdmin && <ShortsImportButton />}
      </Card>
    );
  }
  if (tab === "duplicates") return <ShortsDuplicates />;
  if (tab === "cleaning") return <ShortsCleanup />;
  if (tab === "titles" && isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <ShortsTitleFetch />
        <ShortsCaptionBackfill />
      </div>
    );
  }
  return null;
}

function Shell({ tab, isAdmin }: { tab?: string; isAdmin: boolean }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const visible = TABS.filter((t) => isAdmin || !t.adminOnly);
  const requested = (tab ?? params.get("tab")) as TabKey | null;
  const active: TabKey =
    requested && visible.some((t) => t.key === requested)
      ? requested
      : visible[0].key;

  return (
    <div className="mx-auto max-w-3xl px-3 pb-24 pt-6 text-white">
      <h1 className="mb-4 px-1 text-lg font-semibold">Settings</h1>
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {visible.map((t) => (
          <Link
            key={t.key}
            href={`${pathname}?tab=${t.key}`}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-sm transition",
              t.key === active
                ? "bg-rose-500 font-semibold text-white"
                : "bg-white/5 text-white/60 hover:text-white/90"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <Panel tab={active} isAdmin={isAdmin} />
    </div>
  );
}

export default function SettingsShell({
  tab,
  isAdmin,
}: {
  tab?: string;
  isAdmin: boolean;
}) {
  // useSearchParams needs a boundary; the server already knows the tab, so the
  // fallback is only ever a frame long.
  return (
    <Suspense fallback={null}>
      <Shell tab={tab} isAdmin={isAdmin} />
    </Suspense>
  );
}
