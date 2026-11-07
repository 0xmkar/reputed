// Runs script/Preflight.sol through eth_call, so it needs no keys or funds and writes nothing.
// Results come from Mirror Node simulation of Hedera's code on live testnet state. They are strong
// evidence, not the same thing as a transaction reaching consensus. Run `forge build` first.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC_URL = process.env.RPC_URL ?? 'https://testnet.hashio.io/api';
const MIRROR_NODE = process.env.MIRROR_NODE ?? 'https://testnet.mirrornode.hedera.com';
const IDENTITY_REGISTRY = process.env.IDENTITY_REGISTRY ?? '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const INIT_HBAR = BigInt(process.env.INIT_HBAR ?? 20);
const SCENARIOS = {
  1: 'collection shape (T1.2)',
  2: 'associated holder (T1.6, T1.7, T1.8)',
  3: 'failures (T1.5)',
  4: 'auto-association',
  5: 'revocation (T1.9)',
  6: 'raw HTS rules',
  7: 'real Identity Registry (T3.4, T3.8)',
  8: 'wallet rotated after linking',
  9: 'what the simulator does not enforce',
};

const contracts = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(readFileSync(join(contracts, 'out/Preflight.sol/Preflight.json'), 'utf8'));

async function mirrorAccounts(query) {
  const response = await fetch(`${MIRROR_NODE}/api/v1/accounts?${query}`);
  if (!response.ok) throw new Error(`Mirror Node answered ${response.status}`);
  const { accounts } = await response.json();
  return accounts.filter((a) => !a.deleted && !a.receiver_sig_required);
}

async function exists(address) {
  const response = await fetch(`${MIRROR_NODE}/api/v1/accounts/${address}`);
  return response.ok;
}

// Public testnet accounts with the properties each scenario needs. eth_call needs no signature.
async function pickAccounts() {
  const recent = await mirrorAccounts('limit=100&order=desc&balance=true&account.balance=gte:100000000000');
  const unlimited = recent.filter((a) => a.max_automatic_token_associations === -1 && a.evm_address);
  const older = await mirrorAccounts('limit=100&order=desc&account.id=lt:0.0.7000000&balance=true&account.balance=gte:1');
  const noSlots = older.find((a) => a.max_automatic_token_associations === 0);
  const limited = older.find((a) => a.max_automatic_token_associations > 0);
  if (unlimited.length < 2 || !noSlots || !limited) throw new Error('could not find suitable public accounts');

  let missing;
  do {
    missing = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } while (await exists(missing));

  return {
    from: unlimited[0].evm_address,
    tuple: [IDENTITY_REGISTRY, unlimited[1].evm_address, limited.evm_address, noSlots.evm_address, missing],
  };
}

function encodeArguments(scenario, tuple) {
  const args = execFileSync(
    'cast',
    [
      'abi-encode',
      'constructor(uint256,(address,address,address,address,address),uint256)',
      String(scenario),
      `(${tuple.join(',')})`,
      String(INIT_HBAR * 100_000_000n),
    ],
    { encoding: 'utf8' },
  );
  return args.trim().slice(2);
}

async function simulate(scenario, accounts) {
  const call = {
    from: accounts.from,
    data: artifact.bytecode.object + encodeArguments(scenario, accounts.tuple),
    gas: '0xe4e1c0', // 15,000,000, the network's limit
    value: `0x${((INIT_HBAR + 5n) * 10n ** 18n).toString(16)}`, // the relay counts 18 decimals
  };
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] }),
  });
  const body = await response.json();
  if (body.error) return `FAIL simulation rejected: ${body.error.message}\n`;
  return Buffer.from(body.result.slice(2), 'hex').toString('utf8');
}

const accounts = await pickAccounts();
let failed = 0;
let passed = 0;
for (const [scenario, title] of Object.entries(SCENARIOS)) {
  console.log(`\n${scenario}. ${title}`);
  const report = await simulate(scenario, accounts);
  for (const line of report.trim().split('\n')) {
    console.log(`  ${line}`);
    if (line.startsWith('PASS')) passed += 1;
    if (line.startsWith('FAIL')) failed += 1;
  }
}
console.log(`\n${passed} passed, ${failed} failed (simulated, nothing was written)`);
process.exit(failed === 0 ? 0 : 1);
