// Creates the reviews and scores HCS topics. Run from server/:
//   pnpm exec tsx --env-file=../.env scripts/create-topics.ts
// A topic whose ID is already set in the environment is left alone.
import { PrivateKey, TopicCreateTransaction, type Client } from '@hashgraph/sdk';
import { ConfigError, loadHederaConfig } from '../src/config.ts';
import { createOperatorClient } from '../src/hedera.ts';

async function createTopic(client: Client, key: PrivateKey, memo: string): Promise<string> {
  // No admin key: nobody, including us, can change or delete a published record.
  const response = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setSubmitKey(key.publicKey)
    .execute(client);
  const { topicId } = await response.getReceipt(client);
  if (!topicId) throw new Error('Topic receipt has no topic ID');
  return topicId.toString();
}

async function main(): Promise<void> {
  const config = loadHederaConfig();
  const key = PrivateKey.fromStringECDSA(config.operatorKey);
  const client = await createOperatorClient(config);

  try {
    const topics = [
      ['REVIEWS_TOPIC_ID', 'reputed reviews v1'],
      ['SCORES_TOPIC_ID', 'reputed scores v1'],
    ] as const;
    for (const [name, memo] of topics) {
      const id = process.env[name] || (await createTopic(client, key, memo));
      console.log(`${name}=${id}`);
    }
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : `Failed: ${(err as Error).message}`);
  process.exit(1);
});
