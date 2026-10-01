import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

// Internal read-only endpoints. The indexer container publishes no port and has
// no kamal-proxy route, so these are reachable only inside the Docker network.
const app = new Hono();

app.use("/sql/*", client({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

export default app;
