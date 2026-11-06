#!/usr/bin/env node
// Verifies CreatorRegistry on Sourcify, which HashScan reads. forge 0.2.0 cannot do this: its
// verifier speaks the old API, and server-verify.hashscan.io now redirects to sourcify.dev.
// Usage, from contracts/ after forge build: node script/verify-source.mjs <address> <creationTxHash>
import { readFileSync } from 'node:fs';

const [address, creationTransactionHash] = process.argv.slice(2);
if (!address || !creationTransactionHash) {
  console.error('usage: node script/verify-source.mjs <address> <creationTxHash>');
  process.exit(1);
}

const server = 'https://sourcify.dev/server/v2';
const artifact = JSON.parse(readFileSync('out/CreatorRegistry.sol/CreatorRegistry.json', 'utf8'));
const metadata = JSON.parse(artifact.rawMetadata);
const sources = Object.fromEntries(Object.keys(metadata.sources).map((path) => [path, readFileSync(path, 'utf8')]));

const submitted = await fetch(`${server}/verify/metadata/296/${address}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ metadata, sources, creationTransactionHash }),
});
const { verificationId } = await submitted.json();
if (!verificationId) throw new Error(`Sourcify refused the request with HTTP ${submitted.status}`);

for (let attempt = 0; attempt < 20; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const job = await (await fetch(`${server}/verify/${verificationId}`)).json();
  if (!job.isJobCompleted) continue;
  if (job.error) throw new Error(job.error.message ?? JSON.stringify(job.error));
  console.log(`${job.contract.match}: creation ${job.contract.creationMatch}, runtime ${job.contract.runtimeMatch}`);
  process.exit(0);
}
throw new Error(`Sourcify job ${verificationId} did not finish in time`);
