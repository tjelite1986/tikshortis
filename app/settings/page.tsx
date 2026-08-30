import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { hasShortsPermission } from "@/lib/permissions";
import SettingsShell from "@/components/settings-shell";

export const dynamic = "force-dynamic";

/**
 * The library's admin tools.
 *
 * In elite-v2 these were tabs inside a settings page shared by six sections;
 * here there is one section, so the sharing layer is gone and the tools sit
 * directly on the page. Which tools exist is unchanged.
 */
export default async function SettingsPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await props.searchParams;
  const session = await getSession();
  if (!session) redirect("/login?next=/settings");
  if (!hasShortsPermission(session)) redirect("/");

  return <SettingsShell tab={tab} isAdmin={session.role === "admin"} />;
}
