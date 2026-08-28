/** Last path segment, or empty if the path is only separators. */
export function folderBasename(folder: string): string {
  return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}

const UUID_FOLDER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Label for the chat-header folder chip, or null to hide it.
 *  Workspace UUID dirs and the app's own workspaces folder are not a
 *  project the user picked; home itself is the default, not a pin. */
export function folderChipLabel(folder: string | undefined, home?: string): string | null {
  if (!folder) return null;
  const normalized = folder.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (home) {
    const h = home.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    if (normalized === h) return null;
  }
  if (normalized.includes("/.openmausbot/workspaces/")) return null;
  const name = folderBasename(normalized);
  if (UUID_FOLDER.test(name)) return null;
  return name;
}
