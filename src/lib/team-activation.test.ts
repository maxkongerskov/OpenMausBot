import { describe, expect, it, vi } from "vitest";

import { createTeamActivationQueue } from "./team-activation";
import { isCurrentTeamActivation } from "./team-scope";

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_reason: Error) => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Result {
  activeTeamId: string | null;
}

function makeQueue(request: (teamId: string | null) => Promise<Result>) {
  let current: string | null = null;
  const applied: Array<string | null> = [];
  const rolledBack: Array<string | null> = [];
  const errors: Error[] = [];
  const queue = createTeamActivationQueue<Result>({
    request,
    isCurrent: (requested) => isCurrentTeamActivation(current, requested),
    apply: (result) => {
      current = result.activeTeamId;
      applied.push(result.activeTeamId);
    },
    rollback: (rollbackTeamId) => {
      current = rollbackTeamId;
      rolledBack.push(rollbackTeamId);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    queue,
    setCurrent: (teamId: string | null) => {
      current = teamId;
    },
    get current() {
      return current;
    },
    applied,
    rolledBack,
    errors,
  };
}

describe("team activation queue", () => {
  it("sends switches in click order so a slower first request cannot win on the server", async () => {
    const started: Array<string | null> = [];
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    let server: string | null = "all";
    const { queue, setCurrent } = makeQueue((id) => {
      started.push(id);
      const wait = deferred<void>();
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        server = id;
        return { activeTeamId: id };
      });
    });

    setCurrent("eng");
    const first = queue.enqueue("eng", "all");
    setCurrent("mkt");
    const second = queue.enqueue("mkt", "eng");

    await Promise.resolve();
    expect(started).toEqual(["eng"]);
    expect(inflight).toHaveLength(1);

    inflight[0]!.wait.resolve();
    await first;
    await Promise.resolve();
    expect(started).toEqual(["eng", "mkt"]);
    inflight[1]!.wait.resolve();
    await second;

    expect(server).toBe("mkt");
  });

  it("does not start the later switch until the earlier request settles, even on failure", async () => {
    const started: Array<string | null> = [];
    const inflight: Array<{ id: string | null; wait: ReturnType<typeof deferred<void>> }> = [];
    const { queue, setCurrent, applied, rolledBack, errors } = makeQueue((id) => {
      started.push(id);
      const wait = deferred<void>();
      inflight.push({ id, wait });
      return wait.promise.then(() => {
        throw new Error(`${id} failed`);
      });
    });

    setCurrent("eng");
    const first = queue.enqueue("eng", null);
    setCurrent("mkt");
    const second = queue.enqueue("mkt", "eng");

    await Promise.resolve();
    expect(started).toEqual(["eng"]);
    inflight[0]!.wait.resolve();
    await first;
    expect(applied).toEqual([]);
    expect(rolledBack).toEqual([]);
    expect(errors).toEqual([]);

    await Promise.resolve();
    expect(started).toEqual(["eng", "mkt"]);
    inflight[1]!.wait.resolve();
    await second;
    expect(errors).toHaveLength(1);
    expect(rolledBack).toEqual(["eng"]);
  });

  it("rolls back only the switch that is still on screen", async () => {
    const onError = vi.fn();
    let current: string | null = "eng";
    const first = deferred<Result>();
    const second = deferred<Result>();
    const requests: Array<string | null> = [];
    const queue = createTeamActivationQueue<Result>({
      request: (id) => {
        requests.push(id);
        return id === "eng" ? first.promise : second.promise;
      },
      isCurrent: (requested) => isCurrentTeamActivation(current, requested),
      apply: (result) => {
        current = result.activeTeamId;
      },
      rollback: (rollbackTeamId) => {
        current = rollbackTeamId;
      },
      onError,
    });

    const firstJob = queue.enqueue("eng", null);
    current = "mkt";
    const secondJob = queue.enqueue("mkt", "eng");

    await Promise.resolve();
    first.reject(new Error("eng failed"));
    await firstJob;
    expect(onError).not.toHaveBeenCalled();
    expect(current).toBe("mkt");

    second.resolve({ activeTeamId: "mkt" });
    await secondJob;
    expect(current).toBe("mkt");
    expect(requests).toEqual(["eng", "mkt"]);
  });
});
