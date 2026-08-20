const tone = (value: string) =>
  ["completed", "succeeded", "active", "ok", "published"].includes(value)
    ? "good"
    : ["failed", "interrupted", "degraded", "unknown"].includes(value)
      ? "bad"
      : ["running", "ready"].includes(value)
        ? "live"
        : "warn";
export function Badge({ children }: { children: string }) {
  return (
    <span className={`badge badge-${tone(children)}`}>
      <span aria-hidden="true">●</span>
      {children}
    </span>
  );
}
