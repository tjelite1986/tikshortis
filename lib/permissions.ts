import { db } from "./db";

// Capabilities an admin can grant an individual account. Admins hold every
// permission implicitly (no rows needed). elite-v2 had one key per section;
// here there is one section, so there is one key — but the table stays a table,
// because a grant is a decision someone made and belongs in the data, not in a
// role check spread across twenty routes.
export const PERMISSIONS = [
  { key: "shorts_settings", label: "Shorts settings" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export const PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

function isKey(k: string): k is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(k);
}

export function getUserPermissions(userId: number): PermissionKey[] {
  return (
    db
      .prepare("SELECT permission FROM user_permissions WHERE user_id = ?")
      .all(userId) as { permission: string }[]
  )
    .map((r) => r.permission)
    .filter(isKey);
}

// True if the session may enter a permission-gated area: admins always;
// everyone else only when granted that exact key.
export function hasPermission(
  session: { sub?: string | number; role?: string } | null | undefined,
  key: PermissionKey
): boolean {
  if (!session) return false;
  if (session.role === "admin") return true;
  const userId = Number(session.sub);
  if (!Number.isInteger(userId)) return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?"
      )
      .get(userId, key)
  );
}

// Section guard for the shorts APIs. elite-v2 took a channel here because the
// 18+ side had a permission of its own; this app serves one channel, so the
// parameter is gone and every caller asks the same question.
export function hasShortsPermission(
  session: { sub?: string | number; role?: string } | null | undefined
): boolean {
  return hasPermission(session, "shorts_settings");
}

// Replace a user's granted permissions with the given valid set (admin action).
export function setUserPermissions(userId: number, keys: string[]): void {
  const valid = Array.from(new Set(keys.filter(isKey)));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_permissions WHERE user_id = ?").run(userId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO user_permissions (user_id, permission) VALUES (?, ?)"
    );
    for (const k of valid) ins.run(userId, k);
  });
  tx();
}
