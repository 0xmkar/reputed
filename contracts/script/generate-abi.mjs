// Writes shared/src/abi/creatorRegistry.ts from the compiled artifact. Run `forge build` first.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contracts = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(readFileSync(join(contracts, 'out/CreatorRegistry.sol/CreatorRegistry.json'), 'utf8'));
const target = join(contracts, '../shared/src/abi/creatorRegistry.ts');

const source = `// Generated from contracts/src/CreatorRegistry.sol by contracts/script/generate-abi.mjs. Do not edit.
export const creatorRegistryAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;
`;
writeFileSync(target, source);
console.log(`wrote ${target} (${artifact.abi.length} entries)`);
