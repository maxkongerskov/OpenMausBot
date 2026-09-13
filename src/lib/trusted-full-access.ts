/** Thread-scoped Full access is a copy of an already-granted bot default.
 * The private IPC rejects `{ threadId }` until that default is Full. Grant
 * the default first when needed, then stamp the selected thread. */
export async function applyTrustedFullAccess(
  setMode: (
    botId: string,
    mode: "full",
    options?: { threadId?: string },
  ) => Promise<unknown>,
  args: { botId: string; threadId: string; botDefaultIsFull: boolean },
): Promise<void> {
  if (!args.botDefaultIsFull) {
    await setMode(args.botId, "full");
  }
  await setMode(args.botId, "full", { threadId: args.threadId });
}
