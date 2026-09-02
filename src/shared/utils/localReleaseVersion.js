export function parseLocalPatchNumber(value) {
  const normalized = String(value || "0");
  if (!/^\d+$/.test(normalized)) return 0;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function formatDisplayVersion(version, patchNumber) {
  return `${version}${patchNumber ? ` patch #${patchNumber}` : ""}`;
}
