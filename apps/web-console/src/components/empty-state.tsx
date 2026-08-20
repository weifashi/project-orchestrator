export function EmptyState({
  title = "暂无数据",
  detail = "这里还没有可显示的记录。",
}: {
  title?: string;
  detail?: string;
}) {
  return (
    <div className="empty" role="status">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
