import type { ProviderName } from "../../../src/core/models.ts";
import { createAnthropicProvider } from "./anthropic.ts";
import type { Provider } from "./types.ts";

export function createProvider(name: ProviderName, apiKey: string): Provider {
  switch (name) {
    case "anthropic":
      return createAnthropicProvider({ apiKey });
  }
}
