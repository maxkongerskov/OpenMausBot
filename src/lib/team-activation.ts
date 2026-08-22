/** One /api/teams/active at a time, in click order. Each click gets an
 *  operation id so a repeated pick of the same team cannot be applied or
 *  rolled back by an earlier request. Rollback uses the last team the
 *  server actually accepted, not an optimistic in-between click. */

export interface TeamActivationQueue {
  enqueue: (requestedTeamId: string | null, baselineTeamId: string | null) => Promise<void>;
}

export interface TeamActivationQueueOptions<T> {
  request: (teamId: string | null) => Promise<T>;
  apply: (result: T) => void;
  rollback: (teamId: string | null) => void;
  onError: (error: Error) => void;
}

export function createTeamActivationQueue<T>(opts: TeamActivationQueueOptions<T>): TeamActivationQueue {
  let tail: Promise<void> = Promise.resolve();
  let latestOp = 0;
  let confirmedTeamId: string | null = null;
  let hasConfirmed = false;

  const run = async (opId: number, requestedTeamId: string | null) => {
    try {
      const result = await opts.request(requestedTeamId);
      confirmedTeamId = requestedTeamId;
      hasConfirmed = true;
      if (opId !== latestOp) return;
      opts.apply(result);
    } catch (caught) {
      if (opId !== latestOp) return;
      opts.onError(caught instanceof Error ? caught : new Error(String(caught)));
      opts.rollback(confirmedTeamId);
    }
  };

  return {
    enqueue(requestedTeamId: string | null, baselineTeamId: string | null) {
      const opId = ++latestOp;
      if (!hasConfirmed) {
        confirmedTeamId = baselineTeamId;
        hasConfirmed = true;
      }
      const job = () => run(opId, requestedTeamId);
      const next = tail.then(job, job);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
