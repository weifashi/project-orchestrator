// 与 ConfigService 的 DEFAULT_CAPABILITY_ALLOWLIST 对应。
// 服务端始终以自己的清单求交，这里只决定网页能勾选什么。
export const CAPABILITIES = [
  "read-workspace",
  "write-workspace",
  "network-read",
  "execute-tests",
  "managed-side-effect",
] as const;
