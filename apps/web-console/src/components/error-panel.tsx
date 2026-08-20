export function ErrorPanel({ error }: { error: unknown }) {
  return (
    <div className="error-panel" role="alert">
      <strong>读取失败</strong>
      <span>{error instanceof Error ? error.message : "未知错误"}</span>
    </div>
  );
}
