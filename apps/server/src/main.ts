import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp(config, { logger: process.env.LOG_REQUESTS === '1' });

await app.listen({ host: config.host, port: config.port });
console.log(`[cc-fleet] backend listening on http://${config.host}:${config.port}`);
console.log(`[cc-fleet] turtles connect to ${config.publicUrl.replace(/^http/, 'ws')}/ws/turtle`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
