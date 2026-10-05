// Stored names are display-ish (imports keep the creator's own capitalisation
// and punctuation), so every comparison runs through this.
export function handleOf(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "")
    .replace(/^[._]+|[._]+$/g, "");
}
