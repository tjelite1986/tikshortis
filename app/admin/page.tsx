import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The old /shorts/admin address. Its contents are the Sources tab of Settings
// now; this stays so an old link still lands on them.
export default function AdminPage() {
  redirect("/settings?tab=sources");
}
