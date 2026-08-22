/** One /api/teams/active at a time, in click order. Ignoring a stale
 *  *response* is not enough: a slower first request can still write the
 *  server after a newer switch and leave the two sides on different teams. */

export interface TeamActivationQueue {
  enqueue: (requestedTeamId: string | null, rollbackTeamId: string | null) => Promise<void>;
}

export interface TeamActivationQueueOptions<T> {
  request: (teamId: string | null) => Promise<T>;
  isCurrent: (requestedTeamId: string | null) => boolean;
  apply: (result: T) => void;
  rollback: (rollbackTeamId: string | null) => void;
  onError: (error: Error) => void;
}

export function createTeamActivationQueue<T>(opts: TeamActivationQueueOptions<T>): TeamActivationQueue {
  let tail: Promise<void> = Promise.resolve();

  const run = async (requestedTeamId: string | null, rollbackTeamId: string | null) => {
    try {
      const result = await opts.request(requestedTeamId);
      if (!opts.isCurrent(requestedTeamId)) return;
      opts.apply(result);
    } catch (caught) {
      if (!opts.isCurrent(requestedTeamId)) return;
      opts.onError(caught instanceof Error ? caught : new Error(String(caught)));
      opts.rollback(rollbackTeamId);
    }
  };

  return {
    enqueue(requestedTeamId: string | null, rollbackTeamId: string | null) {
      const job = () => run(requestedTeamId, rollbackTeamId);
      const next = tail.then(job, job);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
