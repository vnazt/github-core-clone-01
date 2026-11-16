// main.ts — trial lifecycle for the forge entry.
//
// The trial pod starts this file with node --experimental-strip-types and
// points MAKEFUN_ENV_URL at its env service. The contract is small: build the
// app, bind an ephemeral port, tell the env which port we took, then wait
// until the env reports the trial is done and exit cleanly. Run without
// MAKEFUN_ENV_URL (a plain local start) it just serves until killed.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

const POLL_INTERVAL_MS = 500;

function boundPort(server: ReturnType<typeof createApp>): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  return (address as AddressInfo).port;
}

async function postRegistration(envUrl: string, port: number): Promise<void> {
  const response = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  // The env keeps the first registration it sees; a non-2xx here means a
  // duplicate or a malformed body, neither of which a retry can repair.
  if (!response.ok) {
    console.error(`registration answered ${response.status}`);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) return;
    } catch {
      // A refused or garbled poll is transient while the env boots; keep
      // asking rather than abandoning the trial.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const port = boundPort(server);
  console.log(`forge entry listening on port ${port}`);

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    // Local run: no env to register with or to dismiss us, so serve on.
    return;
  }

  await postRegistration(envUrl, port);
  await waitForDone(envUrl);

  // Trial over: stop accepting work and leave with a success code. The timer
  // is a backstop in case a lingering connection delays the close callback.
  const force = setTimeout(() => process.exit(0), 1500);
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
