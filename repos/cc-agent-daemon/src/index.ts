import { parseArgs } from "./config.js";
import { createAppContext } from "./app/context.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const ctx = createAppContext(config);
  const server = await startServer(ctx, config);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});