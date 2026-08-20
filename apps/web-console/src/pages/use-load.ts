import { useEffect, useState } from "react";
export function useLoad<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    setError(undefined);
    void load().then(
      (value) => {
        if (active) setData(value);
      },
      (reason) => {
        if (active) setError(reason);
      },
    );
    return () => {
      active = false;
    };
  }, deps);
  return { data, error, setData };
}
