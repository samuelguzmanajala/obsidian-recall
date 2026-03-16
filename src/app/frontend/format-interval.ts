/**
 * Formats an interval in days to a human-readable string.
 * <1d → "< 10m", 1d → "1d", 7d → "7d", 30d → "1mo", 365d → "1y"
 */
export function formatInterval(days: number): string {
  if (days < 1) return '< 10m';
  if (days < 30) return `${days}d`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `${months}mo`;
  }
  const years = Math.round(days / 365 * 10) / 10;
  return `${years}y`;
}
