import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadKimiCodingOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
// kimi-coding.models.ts is missing upstream (not regenerated from models.dev);
// stub the constant so build passes; kimi-coding provider will return [] models until upstream fixes.
const KIMI_CODING_MODELS: readonly any[] = [];

export function kimiCodingProvider(): Provider<"anthropic-messages"> {
	// @ts-expect-error kimi-coding upstream disabled via empty stub; delete this line when upstream adds kimi-coding.models.ts back.
	return createProvider({
		id: "kimi-coding",
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding",
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			oauth: lazyOAuth({
				name: "Kimi Code (subscription)",
				loginLabel: "Sign in with Kimi Code",
				load: loadKimiCodingOAuth,
			}),
		},
		models: Object.values(KIMI_CODING_MODELS),
		api: anthropicMessagesApi(),
	});
}
