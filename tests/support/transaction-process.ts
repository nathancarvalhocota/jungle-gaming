export function processWorker(
  db: { url: string; name: string },
  jobs: { body: unknown; key: string }[],
) {
  let readyResolve: (pid: number) => void;
  let resultResolve: (value: WorkerResult[]) => void;
  let readyReject: (error: Error) => void;
  let resultReject: (error: Error) => void;
  let readyReceived = false;
  let resultReceived = false;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise<WorkerResult[]>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const child = Bun.spawn(
    [process.execPath, "run", "tests/support/bet-process.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        BET_DATABASE_URL: db.url,
        BET_EXPECTED_DATABASE: db.name,
        BET_JOBS: JSON.stringify(jobs),
      },
      stdout: "ignore",
      stderr: "inherit",
      ipc(message: unknown) {
        if (!message || typeof message !== "object") return;
        if (
          "type" in message &&
          message.type === "ready" &&
          "pid" in message &&
          typeof message.pid === "number"
        ) {
          readyReceived = true;
          readyResolve(message.pid);
        }
        if (
          "type" in message &&
          message.type === "result" &&
          "results" in message &&
          Array.isArray(message.results)
        ) {
          resultReceived = true;
          resultResolve(message.results);
        }
      },
    },
  );
  void child.exited.then((code) => {
    if (code !== 0 || !readyReceived || !resultReceived) {
      const error = new Error(`BET worker failed (${code})`);
      if (!readyReceived) readyReject(error);
      if (!resultReceived) resultReject(error);
    }
  });
  return { child, ready, result };
}
type WorkerResult =
  | { error: string }
  | { result: { balance: { amount: string }; idempotentReplay: boolean } };
