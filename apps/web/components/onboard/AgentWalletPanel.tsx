'use client';

import { useState } from 'react';
import { useAccount, useSignTypedData, useWriteContract } from 'wagmi';
import type { Address, EIP1193Provider, Hash, Hex } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY, identityRegistryAbi } from '@reputed/shared';
import { SIGNATURE_LIFETIME_SECONDS, SIGNATURE_SAFETY_SECONDS, agentWalletTypedData } from '@/lib/agentWallet';
import { chainClient } from '@/lib/chainClient';
import { GAS } from '@/lib/contracts';
import { latestBlockTime } from '@/lib/mirror';
import { describeWalletError, notSent } from '@/lib/walletError';
import { AddressChip } from '../AddressChip';
import { InlineError } from '../InlineError';
import { TransactionButton, type TxPhase } from '../TransactionButton';

export const inWallet = (addresses: readonly Address[] | undefined, address: string) =>
  Boolean(addresses?.some((item) => item.toLowerCase() === address.toLowerCase()));

/** Shown when the browser wallet hasn't shared an account with this site. */
export function ShareWallet({ address, action }: { address: Address; action: string }) {
  const { connector } = useAccount();
  const [error, setError] = useState<string | null>(null);

  async function share() {
    setError(null);
    try {
      const provider = (await connector?.getProvider()) as EIP1193Provider | undefined;
      await provider?.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    } catch (err) {
      const { rejected, message } = describeWalletError(err);
      setError(rejected ? 'Cancelled in your wallet' : message);
    }
  }

  return (
    <div className="onboard-step-box">
      <p className="onboard-text">
        To {action}, this site needs access to <AddressChip address={address} /> as well as your creator wallet. Select both in your wallet.
      </p>
      <div>
        <button type="button" className="btn btn-outline" onClick={share}>
          Choose accounts in wallet
        </button>
      </div>
      {error && <InlineError message={error} />}
    </div>
  );
}

interface Signed {
  signature: Hex;
  deadline: bigint;
  usableUntilMs: number;
}

interface Props {
  agentId: string;
  creator: Address;
  agentWallet: Address;
  pendingTx: Hash | undefined;
  creatorAvailable: boolean;
  onSubmitted: (hash: Hash) => void;
  onSet: () => void;
  onCleared: () => void;
  onPhase: (phase: TxPhase) => void;
  /** Why this has to be done again, when a sent transaction did not leave the wallet set. */
  notice: string | null;
}

/**
 * The agent wallet signs, then the creator sends: setAgentWallet must come from the agent's owner, and
 * the signature names the agent, its owner and a deadline at most 5 minutes out. So this happens after
 * register, and before linkAgent because linkAgent vouches for whichever wallet is set at that moment.
 */
export function AgentWalletPanel({ agentId, creator, agentWallet, pendingTx, creatorAvailable, onSubmitted, onSet, onCleared, onPhase, notice }: Props) {
  const { addresses, chainId } = useAccount();
  const { mutateAsync: signTypedData, isPending: signing } = useSignTypedData();
  const { mutateAsync: writeContract } = useWriteContract();
  const [signed, setSigned] = useState<Signed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = inWallet(addresses, agentWallet);
  const onWrongNetwork = chainId !== HEDERA_TESTNET.id;
  const shownError = error ?? notice;

  async function sign() {
    setError(null);
    try {
      // The deadline is checked against block time, so a wrong clock on this device mustn't decide it.
      // Its lifetime starts now, so time spent in the wallet comes out of it.
      const startedMs = Date.now();
      const now = (await latestBlockTime()) ?? BigInt(Math.floor(startedMs / 1000));
      const deadline = now + BigInt(SIGNATURE_LIFETIME_SECONDS);
      const signature = await signTypedData({
        account: agentWallet,
        ...agentWalletTypedData({ agentId: BigInt(agentId), newWallet: agentWallet, owner: creator, deadline }),
      });
      setSigned({ signature, deadline, usableUntilMs: startedMs + (SIGNATURE_LIFETIME_SECONDS - SIGNATURE_SAFETY_SECONDS) * 1000 });
    } catch (err) {
      const { rejected, message } = describeWalletError(err);
      setError(rejected ? 'Cancelled in your wallet' : message);
    }
  }

  async function send(): Promise<Hash> {
    if (!signed || Date.now() > signed.usableUntilMs) {
      setSigned(null);
      setError('The signature expired. Sign again.');
      throw notSent('The signature expired. Sign again.');
    }
    return writeContract({
      address: IDENTITY_REGISTRY,
      abi: identityRegistryAbi,
      functionName: 'setAgentWallet',
      args: [BigInt(agentId), agentWallet, signed.deadline, signed.signature],
      gas: GAS.setAgentWallet,
      account: creator,
      chainId: HEDERA_TESTNET.id,
    });
  }

  async function findSent(): Promise<true | null> {
    const set = await chainClient.readContract({
      address: IDENTITY_REGISTRY,
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      args: [BigInt(agentId)],
    });
    return set.toLowerCase() === agentWallet.toLowerCase() ? true : null;
  }

  if (signed || pendingTx) {
    return (
      <div className="onboard-step-box">
        <p className="onboard-text">
          {pendingTx ? 'Setting the agent wallet.' : 'Signed by the agent wallet. Now send it from your creator wallet.'}
        </p>
        <TransactionButton
          label="Set agent wallet"
          resumeHash={pendingTx}
          disabled={!creatorAvailable}
          onSend={send}
          onSubmitted={onSubmitted}
          onConfirmed={onSet}
          findSent={findSent}
          onFound={onSet}
          onPhase={onPhase}
          onFailed={({ reason }) => {
            // A revert spends the signature's usefulness: reasons include expiry and a wrong signer.
            setSigned(null);
            setError(reason);
            onCleared();
          }}
        />
      </div>
    );
  }

  if (!available) {
    return (
      <>
        <ShareWallet address={agentWallet} action="sign with your agent wallet" />
        {shownError && <InlineError message={shownError} />}
      </>
    );
  }

  return (
    <div className="onboard-step-box">
      <p className="onboard-text">
        <AddressChip address={agentWallet} /> has to agree to act for this agent. It signs a message, which costs nothing.
      </p>
      <div>
        <button type="button" className="btn btn-primary" disabled={signing || onWrongNetwork} onClick={sign}>
          {signing ? 'Waiting for signature…' : 'Sign with agent wallet'}
        </button>
      </div>
      {shownError && <InlineError message={shownError} />}
    </div>
  );
}
