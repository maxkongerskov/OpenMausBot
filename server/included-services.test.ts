// Own Boat, ElevenLabs and Jev credentials. A missing key is not configured.
// Leftover Cloud Pro relay variables are ignored.
import { describe, expect, it } from "vitest";

import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";
import { boatCredential, deciderCredential, voiceCredential } from "./included-services.ts";

const leftover = {
  OMB_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
  OMB_CLOUD_BOAT_TOKEN: "box_omb_included",
  OMB_CLOUD_VOICE_URL: "https://cloud.example.test/api/cloud/services/voice/v1",
  OMB_CLOUD_VOICE_TOKEN: "omb_voice_included",
  OMB_CLOUD_DECIDER_URL: "https://cloud.example.test/api/cloud/services/decider",
  OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included",
};

describe("own credentials", () => {
  it("uses a Boat token only with Boat", () => {
    expect(boatCredential(undefined)).toBeNull();
    expect(boatCredential("")).toBeNull();
    expect(boatCredential("box_own")).toEqual({ token: "box_own", api: "https://ascii.dev/api/box/v1" });
    expect(boatCredential("box_own", { OMB_BOX_API: "http://127.0.0.1:9/api/box/v1" }))
      .toEqual({ token: "box_own", api: "http://127.0.0.1:9/api/box/v1" });
  });

  it("ignores leftover Cloud Pro Boat relay tokens", () => {
    expect(boatCredential(undefined, leftover)).toBeNull();
    expect(boatCredential("", leftover)).toBeNull();
  });

  it("uses an ElevenLabs key only with ElevenLabs", () => {
    expect(voiceCredential(undefined, leftover)).toBeNull();
    expect(voiceCredential("sk-own")).toEqual({ token: "sk-own", api: "https://api.elevenlabs.io/v1" });
    expect(voiceCredential("sk-own", { OMB_ELEVENLABS_API: "http://127.0.0.1:9/v1" }))
      .toEqual({ token: "sk-own", api: "http://127.0.0.1:9/v1" });
  });

  it("uses a Jev key with the person's base URL or Jev's own", () => {
    expect(deciderCredential(undefined, undefined)).toBeNull();
    expect(deciderCredential("tsk", undefined)).toEqual({ token: "tsk", api: JEV_DEFAULT_BASE_URL });
    expect(deciderCredential("tsk", "https://jev.example/v1")).toEqual({ token: "tsk", api: "https://jev.example/v1" });
    expect(deciderCredential(undefined, "https://jev.example/v1")).toBeNull();
  });
});
