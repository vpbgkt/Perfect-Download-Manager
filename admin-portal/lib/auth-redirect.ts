export function getSafeRedirectPath(next: string | null, origin: string): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return "/dashboard";

  try {
    const destination = new URL(next, origin);
    if (destination.origin !== origin) return "/dashboard";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/dashboard";
  }
}
