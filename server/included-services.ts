// The person's own Boat, ElevenLabs and Jev credentials. Each token is sent
// only to that provider. Cloud Pro relay tokens are not read.
import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

export const BOAT_API_DEFAULT = "https://ascii.dev/api/box/v1";
export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
}

function ownCredential(token: string | undefined, api: string): ServiceCredential | null {
  const secret = token?.trim();
  return secret ? { token: secret, api } : null;
}

export const boatProviderApi = (env: NodeJS.ProcessEnv = process.env): string => env.OMB_BOX_API || BOAT_API_DEFAULT;
export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OMB_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

/** The person's Boat token, or null when none is saved. */
export function boatCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return ownCredential(own, boatProviderApi(env));
}

/** The person's ElevenLabs key, or null when none is saved. */
export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return ownCredential(own, elevenLabsProviderApi(env));
}

/** The person's Jev key with their base URL, or Jev's own when none is set. */
export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
): ServiceCredential | null {
  return ownCredential(own, ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL);
}
