// 驗證金鑰：呼叫官方「列出模型」API（不產生費用）。
// 只為這一個請求不引入 SDK，讓這個工具維持零套件，方便之後打包給別人。

export type Validation = { ok: true } | { ok: false; reason: "invalid" | "error"; message: string };

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

export async function validateKey(key: string, fetchImpl: typeof fetch = fetch): Promise<Validation> {
  let response: Response;
  try {
    response = await fetchImpl(MODELS_URL, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, reason: "error", message: `連不上 API：${(error as Error).message}` };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "invalid", message: "金鑰無效或沒有權限" };
  }
  return { ok: false, reason: "error", message: `API 回應 ${response.status}` };
}
