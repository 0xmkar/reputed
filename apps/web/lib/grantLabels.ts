// A label is only a note to the creator, so it stays in this browser instead of on a server.
const STORAGE_KEY = 'reputed:grant-labels';

function read(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function getGrantLabel(grantKey: string): string | undefined {
  return read()[grantKey.toLowerCase()];
}

export function saveGrantLabel(grantKey: string, label: string): void {
  const labels = read();
  const trimmed = label.trim();
  if (trimmed) labels[grantKey.toLowerCase()] = trimmed;
  else delete labels[grantKey.toLowerCase()];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
  } catch {
    // Storage is blocked: the key still works, it just has no name.
  }
}
