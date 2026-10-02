// Child process for redact.test.ts: an uncaught error (or unhandled rejection)
// whose message contains the RPC URL, with the handlers reconcile and prune use.
import { installFatalHandlers, installRedaction } from "../../lib/redact";

installRedaction();
installFatalHandlers();

const error = new Error(`request failed. URL: ${process.env.PONDER_RPC_URL_80002}`, {
  cause: new Error(`inner ${process.env.PONDER_RPC_URL_80002}`),
});
if (process.argv.includes("--rejection")) {
  void Promise.reject(error);
} else {
  setTimeout(() => {
    throw error;
  }, 0);
}
