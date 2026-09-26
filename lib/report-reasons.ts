// The reasons a viewer can report a clip for. Shared by the player menu and the
// report route (which refuses anything else). Kept apart from lib/shorts-reports
// so the client bundle never pulls the database in. The list is a self-hosted
// library's, not a platform's: most reports here will be about a clip that is
// broken, misfiled or a duplicate, and only rarely about its content.
export const REPORT_REASONS = [
  "broken",
  "wrong_creator",
  "duplicate",
  "inappropriate",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  broken: "Video does not play or is cut off",
  wrong_creator: "Wrong creator or title",
  duplicate: "Duplicate of another clip",
  inappropriate: "Inappropriate content",
  other: "Something else",
};

export function parseReportReason(raw: unknown): ReportReason | null {
  return typeof raw === "string" &&
    (REPORT_REASONS as readonly string[]).includes(raw)
    ? (raw as ReportReason)
    : null;
}
