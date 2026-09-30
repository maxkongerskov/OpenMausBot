// Whether the first-run email step was finished on this machine. Local only:
// the address, when one was given, lives in the workspace profile.
const GATE_KEY = "omb-email-gate";

export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}

export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
