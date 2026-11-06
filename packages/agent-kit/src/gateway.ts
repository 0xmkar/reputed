import {
  ContractExecuteTransaction,
  ContractId,
  ReceiptStatusError,
  TokenAssociateTransaction,
  type Client,
} from '@hiero-ledger/sdk';
import type { Hex } from 'viem';
import { ReputedAgentError } from './errors';

export interface TxOutcome {
  /** In the Mirror Node's spelling: 0.0.1234-1700000000-123456789. */
  transactionId: string;
  /** The receipt status, for example SUCCESS or CONTRACT_REVERT_EXECUTED. */
  status: string;
}

/** What onboarding needs from a Hedera account. Tests replace it with a fake. */
export interface HederaGateway {
  readonly accountId: string;
  executeContract(contractId: string, data: Hex, gas: bigint): Promise<TxOutcome>;
  associateToken(tokenId: string): Promise<TxOutcome>;
}

/** 0.0.1234@1700000000.123456789 → 0.0.1234-1700000000-123456789 */
export function toMirrorTransactionId(id: string): string {
  const [account = '', time = ''] = id.split('@');
  return `${account}-${time.replace('.', '-')}`;
}

async function settle(client: Client, response: { transactionId: { toString(): string }; getReceipt(client: Client): Promise<{ status: { toString(): string } }> }): Promise<TxOutcome> {
  const transactionId = toMirrorTransactionId(response.transactionId.toString());
  try {
    const receipt = await response.getReceipt(client);
    return { transactionId, status: receipt.status.toString() };
  } catch (error) {
    // A revert still has a transaction ID and a result on the Mirror Node, which says why.
    if (error instanceof ReceiptStatusError) return { transactionId, status: error.status.toString() };
    throw error;
  }
}

function precheckFailure(error: unknown): ReputedAgentError | null {
  const status = (error as { status?: { toString(): string } } | null)?.status?.toString();
  if (!status || !(error instanceof Error) || error.name === 'ReceiptStatusError') return null;
  if (status === 'INSUFFICIENT_PAYER_BALANCE') {
    return new ReputedAgentError('INSUFFICIENT_HBAR', 'The agent account does not have enough HBAR to pay for this transaction.', { cause: error });
  }
  return new ReputedAgentError('TRANSACTION_FAILED', `Hedera rejected the transaction: ${status}.`, { cause: error });
}

export function clientGateway(client: Client): HederaGateway {
  const operator = client.operatorAccountId;
  if (!operator) {
    throw new ReputedAgentError('NO_OPERATOR', 'The Hedera Client has no operator. Call client.setOperator(accountId, privateKey) first.');
  }

  return {
    accountId: operator.toString(),
    async executeContract(contractId, data, gas) {
      try {
        const response = await new ContractExecuteTransaction()
          .setContractId(ContractId.fromString(contractId))
          .setGas(Number(gas))
          .setFunctionParameters(Buffer.from(data.slice(2), 'hex'))
          .execute(client);
        return await settle(client, response);
      } catch (error) {
        throw precheckFailure(error) ?? error;
      }
    },
    async associateToken(tokenId) {
      try {
        const response = await new TokenAssociateTransaction().setAccountId(operator).setTokenIds([tokenId]).execute(client);
        return await settle(client, response);
      } catch (error) {
        throw precheckFailure(error) ?? error;
      }
    },
  };
}
