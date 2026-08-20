import { useState } from "react";

export function VersionInspector({
  load,
}: {
  load: () => Promise<{ envelope: unknown }>;
}) {
  const [envelope, setEnvelope] = useState<unknown>(),
    [error, setError] = useState("");
  if (envelope !== undefined)
    return (
      <pre className="version-json">{JSON.stringify(envelope, null, 2)}</pre>
    );
  return (
    <span>
      <button
        className="button"
        type="button"
        onClick={() => {
          setError("");
          void load().then(
            (result) => setEnvelope(result.envelope),
            (reason: unknown) =>
              setError(reason instanceof Error ? reason.message : "读取失败"),
          );
        }}
      >
        查看版本正文
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </span>
  );
}
