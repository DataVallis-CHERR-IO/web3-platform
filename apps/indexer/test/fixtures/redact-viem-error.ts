// Child process for redact.test.ts: a real viem request failure, caught and printed.
import { createPublicClient, http } from "viem";
import { installRedaction } from "../../lib/redact";

installRedaction();

const url = process.env.PONDER_RPC_URL_80002!;
const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
try {
  await client.getBlockNumber();
} catch (error) {
  console.error(error);
  console.log(`stdout too: ${(error as Error).message}`);
  process.stdout.write(Buffer.from(`as bytes: ${url}\n`));
  process.exitCode = 7; // must survive the redaction untouched
}
