/**
 * The AI providers the parent can pick, and the exact URLs the app calls. The CSP's
 * connect-src in vercel.json lists exactly these (securityHeaders.test.ts checks it),
 * so her chats can't be sent anywhere else.
 */
export type AiProviderId = 'venice';

export interface AiProvider {
  /** Shown to the parent. */
  name: string;
  origin: string;
  endpoints: {
    /** Chat completions (OpenAI-compatible), streamed. */
    chat: string;
    /** A cheap authenticated call for "בדיקת חיבור". */
    check: string;
  };
}

export const AI_PROVIDERS: Record<AiProviderId, AiProvider> = {
  venice: {
    name: 'Venice AI',
    origin: 'https://api.venice.ai',
    endpoints: {
      chat: 'https://api.venice.ai/api/v1/chat/completions',
      check: 'https://api.venice.ai/api/v1/api_keys/rate_limits',
    },
  },
};

export function allEndpoints(): string[] {
  return Object.values(AI_PROVIDERS).flatMap((p) => Object.values(p.endpoints));
}
