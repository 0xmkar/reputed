// Process entry point. Config is validated before anything opens, so a bad environment exits
// with the names of the offending variables and nothing else. The HTTP app and the epoch loop
// run in one process and share one scorer store (indexer/runtime.ts).
import { buildApp } from './app.ts';
import { createChainClients, createCreatorRegistryGateway } from './chain.ts';
import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { createReviewPublisher } from './hedera.ts';
import { getScorerRuntime } from './indexer/runtime.ts';
import { createMirror } from './mirror.ts';
import { startEpochLoop } from './scoring/scheduler.ts';
import { createVerificationStore } from './verificationStore.ts';
import { createWorldClient } from './world/client.ts';

function config(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const cfg = config();
const { publicClient, walletClient } = createChainClients(cfg.rpcUrl, cfg.verifierKey);
const mirror = createMirror(cfg.mirrorNode);
const store = createVerificationStore(cfg.verifierDbPath, {
  registry: cfg.creatorRegistry,
  action: cfg.world.action,
});

const app = await buildApp(
  {
    world: cfg.world,
    sessionSecret: cfg.sessionSecret,
    identityRegistry: cfg.identityRegistry,
    corsOrigins: cfg.corsOrigins,
    trustProxy: cfg.trustProxy,
    verifier: createWorldClient(cfg.world),
    registry: createCreatorRegistryGateway({
      publicClient,
      walletClient,
      address: cfg.creatorRegistry,
      transactionIdOf: mirror.transactionIdOf,
    }),
    store,
    publisher: createReviewPublisher(cfg, cfg.reviewsTopicId),
    reviewBudget: cfg.reviewBudget,
  },
  { logger: { level: 'info' } },
);

await app.listen({ port: cfg.port, host: '0.0.0.0' });
const epochLoop = startEpochLoop();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // The loop finishes its current tick before either SQLite handle closes.
    void Promise.allSettled([epochLoop.stop(), app.close()]).finally(() => {
      store.close();
      getScorerRuntime().store.close();
      process.exit(0);
    });
  });
}
