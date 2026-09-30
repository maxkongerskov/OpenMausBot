import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DATA_DIR, loadConfig, parseConfigPatch, parseStoredConfig, providerReloadKeys, saveConfig, stripWorkspaceCredentialEnv, syncCredentialEnv,
} from "../config.ts";
import { deciderSavePatch, describeDecider } from "./index.ts";

const KEY = "tsk_config_secret_0123456789";

describe("decider config", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    delete process.env.OMB_JEV_API_KEY;
  });
  afterEach(() => { delete process.env.OMB_JEV_API_KEY; });

  it("saving decision-model settings never reloads the engine fleet", () => {
    expect(providerReloadKeys({ decider: { enabled: true, key: KEY, jobs: { roomRouting: false } } })).toEqual([]);
  });

  it("engines never inherit the key, nor Cloud Pro's included token", () => {
    const childEnv: Record<string, string | undefined> = { OMB_JEV_API_KEY: KEY, OMB_CLOUD_DECIDER_TOKEN: "omb_decide_included", PATH: "/usr/bin" };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv).toEqual({ PATH: "/usr/bin" });
  });

  it("the env key wins over the file, and a save keeps the env in step", () => {
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ decider: { enabled: true, key: "" } }));
    process.env.OMB_JEV_API_KEY = KEY;
    expect(loadConfig().decider?.key).toBe(KEY);
    syncCredentialEnv({ decider: { key: "tsk_new" } });
    expect(process.env.OMB_JEV_API_KEY).toBe("tsk_new");
    syncCredentialEnv({ decider: { key: "" } });
    expect(process.env.OMB_JEV_API_KEY).toBeUndefined();
  });

  it("saving a key persists the switch and the room job on, merged into the section", () => {
    saveConfig({ decider: { jobs: { roomRouting: false } } });
    const planned = deciderSavePatch({ key: KEY }, loadConfig().decider);
    if (!planned.ok) throw new Error(planned.error);
    saveConfig({ decider: planned.patch });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.decider).toEqual({ key: KEY, enabled: true, jobs: { roomRouting: true } });
    expect(describeDecider(loadConfig())).toEqual({ provider: "jev", configured: true, enabled: true, jobs: { roomRouting: true } });
  });

  it("validates the section: a base URL must be http(s), the provider known", () => {
    expect(parseConfigPatch({ decider: { baseUrl: "http://127.0.0.1:9000", enabled: true } }).decider).toEqual({ baseUrl: "http://127.0.0.1:9000", enabled: true });
    expect(() => parseConfigPatch({ decider: { baseUrl: "file:///etc/passwd" } })).toThrow();
    expect(() => parseConfigPatch({ decider: { provider: "someone-else" } })).toThrow();
    // an older file without the section still loads
    expect(parseStoredConfig({ tts: { voice: "narrator" } }).decider).toBeUndefined();
  });
});
