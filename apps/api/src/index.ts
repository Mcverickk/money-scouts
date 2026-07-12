import 'dotenv/config';
import Fastify from 'fastify';
import { eventsRoutes } from './routes/events.js';
import { marketChecksRoutes } from './routes/marketChecks.js';
import { replaysRoutes } from './routes/replays.js';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

await app.register(eventsRoutes);
await app.register(marketChecksRoutes);
await app.register(replaysRoutes);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
