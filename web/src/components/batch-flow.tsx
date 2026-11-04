'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Anchor, ArrowUpRight, Check, Eye, Globe, Landmark, LockKeyhole, Pause, Play, ShieldCheck, Users, Wallet, X, ArrowDownToLine } from 'lucide-react';
import type { Address, Hex } from 'viem';
import { money, short, type Batch, type Payment, type Withdrawal } from '@/lib/whale';
import './batch-flow.css';

export type FlowAnchor = { resultTx: Hex; monadBlock: string; resultMonadBlock?: string; stateRoot: Hex; postedOnChain: boolean };
type NodeState = 'done' | 'active' | 'waiting' | 'stopped';
type Detail = { label: string; value: string; href?: string; mono?: boolean };
export type FlowStep = {
  id: string; icon: typeof Wallet; title: string; subtitle: string; state: NodeState;
  edge?: string; // label on the connector leading INTO this node
  heading: string; body: string; visibility: string; visibilityTone: 'public' | 'staff' | 'private';
  details: Detail[]; extra?: ReactNode;
};

const STEP_MS = 4200;

/** Polls a receipt until its state root is posted on Monad (usually 1-2 s after execution). */
function useAnchor(enabled: boolean, key: string, load: () => Promise<FlowAnchor | null>) {
  const [anchor, setAnchor] = useState<FlowAnchor | null>(null);
  const loader = useRef(load); loader.current = load;
  useEffect(() => {
    setAnchor(null);
    if (!enabled) return;
    let active = true, attempts = 0; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const result = await loader.current().catch(() => null);
      if (!active) return;
      setAnchor(result);
      if (!result?.postedOnChain && ++attempts < 40) timer = setTimeout(tick, 3000);
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, key]);
  return anchor;
}

/** A workflow-style rail of steps with animated connectors, a guided walkthrough and an explanation panel. */
export function FlowRail({ steps, eyebrow, summary, label, initial = 0 }: { steps: FlowStep[]; eyebrow: string; summary: ReactNode; label: string; initial?: number }) {
  const [selected, setSelected] = useState(initial);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => { if (selected >= steps.length - 1) setPlaying(false); else setSelected(selected + 1); }, STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, selected, steps.length]);

  const current = steps[Math.min(selected, steps.length - 1)];
  const edgeState = (i: number) => { const to = steps[i].state; return to === 'done' ? 'flowing' : to === 'active' ? 'arriving' : 'idle'; };

  return (
    <section className="flow" aria-label={label}>
      <header className="flow-head">
        <div>
          <span className="flow-eyebrow">{eyebrow}</span>
          <p>{summary}</p>
        </div>
        <button className="flow-play" onClick={() => { if (!playing && selected >= steps.length - 1) setSelected(0); setPlaying(!playing); }} aria-pressed={playing}>
          {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? 'Pause' : 'Play the journey'}
        </button>
      </header>

      <div className="flow-canvas" role="list">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <div className="flow-cell" key={step.id} role="listitem">
              {i > 0 && (
                <div className={`flow-edge ${edgeState(i)} ${selected === i ? 'focus' : ''}`} aria-hidden="true">
                  <span className="flow-edge-line" />
                  {edgeState(i) !== 'idle' && <span className="flow-packet" style={{ animationDelay: `${i * .35}s` }} />}
                  <span className="flow-edge-label">{step.edge}</span>
                </div>
              )}
              <motion.button
                className={`flow-node ${step.state} ${selected === i ? 'selected' : ''}`}
                onClick={() => { setPlaying(false); setSelected(i); }}
                initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * .08, duration: .35, ease: 'easeOut' }}
                aria-current={selected === i ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${step.title}, ${step.state === 'done' ? 'complete' : step.state === 'active' ? 'in progress' : step.state === 'stopped' ? 'stopped' : 'not started'}`}
              >
                <span className="flow-port in" /><span className="flow-port out" />
                <span className="flow-icon">
                  <Icon size={20} strokeWidth={1.6} />
                  {step.state === 'done' && <span className="flow-badge"><Check size={10} strokeWidth={3} /></span>}
                  {step.state === 'stopped' && <span className="flow-badge stop"><X size={10} strokeWidth={3} /></span>}
                </span>
                <strong>{step.title}</strong>
                <small>{step.subtitle}</small>
              </motion.button>
            </div>
          );
        })}
      </div>

      <div className="flow-progress" aria-hidden="true">
        {steps.map((s, i) => <span key={s.id} className={i < selected ? 'past' : i === selected ? 'now' : ''}>{i === selected && playing && <motion.i key={`${selected}-p`} initial={{ width: 0 }} animate={{ width: '100%' }} transition={{ duration: STEP_MS / 1000, ease: 'linear' }} />}</span>)}
      </div>

      <AnimatePresence mode="wait">
        <motion.article key={current.id + current.state} className="flow-explain" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .22 }} aria-live="polite">
          <div className="flow-explain-main">
            <span className="flow-step-no">Step {selected + 1} of {steps.length}</span>
            <h3>{current.heading}</h3>
            <p>{current.body}</p>
            {current.extra}
          </div>
          <aside>
            <span className={`flow-visibility ${current.visibilityTone}`}><Eye size={13} /> {current.visibility}</span>
            <dl>
              {current.details.map(d => (
                <div key={d.label + d.value}>
                  <dt>{d.label}</dt>
                  <dd className={d.mono ? 'mono' : ''} title={d.value}>
                    {d.href ? <a href={d.href} target="_blank" rel="noreferrer">{d.mono ? short(d.value) : d.value} <ArrowUpRight size={11} /></a> : d.mono ? short(d.value) : d.value}
                  </dd>
                </div>
              ))}
            </dl>
          </aside>
        </motion.article>
      </AnimatePresence>
    </section>
  );
}

/** Staff view: one batch from the finance wallet to every recipient. */
export function BatchFlow({ batch, threshold, approvers, hub, treasury, explorer, labelOf, loadAnchor }: {
  batch: Batch; threshold: number; approvers: Address[]; hub: Address; treasury: Address; explorer: string;
  labelOf: (address: string) => string; loadAnchor: () => Promise<FlowAnchor | null>;
}) {
  const anchor = useAnchor(batch.status === 'Executed', `${batch.id}-${batch.status}`, loadAnchor);
  const approvedBy = (batch.approvedBy || []).map(a => a.toLowerCase());
  const payees = batch.payees || [];
  const executed = batch.status === 'Executed', cancelled = batch.status === 'Cancelled';
  const remaining = Math.max(threshold - batch.approvals, 0);
  const total = `${money(batch.total)} pUSDC`;
  const tx = (hash: string) => `${explorer}/tx/${hash}`, addr = (a: string) => `${explorer}/address/${a}`;

  const steps: FlowStep[] = useMemo(() => [
    {
      id: 'sign', icon: Wallet, title: 'Finance wallet', subtitle: labelOf(batch.proposer), state: 'done',
      heading: 'The payout is prepared and sealed',
      body: `${labelOf(batch.proposer)} listed ${batch.payeeCount} recipients for ${total} and signed the batch in the browser. Before it left the device, it was encrypted so only the Whale operator can open it.`,
      visibility: 'Only the finance lead, before encryption', visibilityTone: 'private',
      details: [{ label: 'Signed by', value: batch.proposer, href: addr(batch.proposer), mono: true }, { label: 'Batch', value: `#${batch.id}` }],
    },
    {
      id: 'hub', icon: Globe, title: 'Monad Hub', subtitle: 'Public network', state: 'done', edge: 'sealed',
      heading: 'A sealed envelope is posted in public',
      body: 'A relayer posts the encrypted batch to the Whale Hub contract on Monad and pays the network fee. Anyone can see that a submission happened, but not who is paid or how much.',
      visibility: 'Everyone, as unreadable ciphertext', visibilityTone: 'public',
      details: [{ label: 'Hub contract', value: hub, href: addr(hub), mono: true }, { label: 'Readable on chain', value: 'Sender, size and time only' }],
    },
    {
      id: 'ledger', icon: LockKeyhole, title: 'MPSD ledger', subtitle: `Batch #${batch.id}`, state: 'done', edge: 'opened',
      heading: 'The batch is opened inside MPSD',
      body: `The operator reads the submission from Monad, decrypts it and records batch #${batch.id} in the private Treasury contract inside the private settlement domain. The funds are earmarked, but nothing moves until the approvers agree.`,
      visibility: 'Finance, approvers and the auditor', visibilityTone: 'staff',
      details: [{ label: 'Treasury contract', value: treasury, mono: true }, { label: 'Recipients', value: String(batch.payeeCount) }, { label: 'Total', value: total }],
    },
    {
      id: 'approve', icon: ShieldCheck, title: 'Approvals', subtitle: `${batch.approvals} of ${threshold} signed`,
      state: executed ? 'done' : cancelled ? 'stopped' : 'active', edge: 'sign-off',
      heading: executed ? 'Two people agreed, so the money moved' : cancelled ? 'This batch was cancelled' : `Waiting for ${remaining} more approval${remaining === 1 ? '' : 's'}`,
      body: executed
        ? `${approvedBy.map(labelOf).join(' and ')} each sent their own signed, encrypted approval. The approval that reached ${threshold} of ${approvers.length} released the payout in the same private block.`
        : cancelled ? 'The batch stopped here. No recipient was paid.'
        : `${threshold} of ${approvers.length} approvers must sign off. Each approval is its own encrypted submission through Monad. The finance lead cannot approve their own batch.`,
      visibility: 'Finance, approvers and the auditor', visibilityTone: 'staff',
      details: approvers.map(a => ({ label: labelOf(a), value: approvedBy.includes(a.toLowerCase()) ? 'Approved' : executed ? 'Not needed' : 'Waiting' })),
      extra: <div className="flow-signers">{approvers.map(a => <span key={a} className={approvedBy.includes(a.toLowerCase()) ? 'signed' : ''} title={a}>{approvedBy.includes(a.toLowerCase()) ? <Check size={11} /> : null}{labelOf(a)}</span>)}</div>,
    },
    {
      id: 'pay', icon: Users, title: 'Recipients', subtitle: `${batch.payeeCount} wallets`,
      state: executed ? 'done' : cancelled ? 'stopped' : 'waiting', edge: 'paid',
      heading: executed ? `${batch.payeeCount} private balances were credited` : 'Recipients are paid once approved',
      body: `Each recipient's private balance goes up by their own amount, ${total} in all. A recipient sees only their own line; if they try to read a colleague's balance, the contract refuses.`,
      visibility: 'Each recipient sees only their own amount', visibilityTone: 'private',
      details: payees.slice(0, 4).map(p => ({ label: labelOf(p.payee), value: `${money(p.amount)} pUSDC` })).concat(payees.length > 4 ? [{ label: 'And', value: `${payees.length - 4} more` }] : []),
      extra: <div className="flow-fan">{payees.slice(0, 6).map((p, i) => <motion.span key={p.payee} title={p.payee} initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: .15 + i * .06 }}>{labelOf(p.payee).replace(/\D+/g, '') || '•'}</motion.span>)}{payees.length > 6 && <span className="more">+{payees.length - 6}</span>}</div>,
    },
    {
      id: 'anchor', icon: Anchor, title: 'Proof on Monad', subtitle: anchor?.postedOnChain ? `Block ${anchor.resultMonadBlock || anchor.monadBlock}` : executed ? 'Posting…' : 'After payment',
      state: !executed ? (cancelled ? 'stopped' : 'waiting') : anchor?.postedOnChain ? 'done' : 'active', edge: 'root',
      heading: anchor?.postedOnChain ? 'A fingerprint of the result is public' : 'A fingerprint of the result goes public',
      body: 'The operator committee signs a single hash of the new private state and posts it to the Hub. Any payment in this batch can later be proven against it, without revealing the others. From here, recipients can withdraw to their own Monad wallets.',
      visibility: 'Everyone, as a hash only', visibilityTone: 'public',
      details: anchor?.postedOnChain
        ? [{ label: 'Posted in', value: anchor.resultTx, href: tx(anchor.resultTx), mono: true }, { label: 'State root', value: anchor.stateRoot, mono: true }]
        : [{ label: 'Status', value: executed ? 'Waiting for Monad confirmation' : 'Not started' }],
    },
  ], [batch, threshold, approvers, hub, treasury, anchor, executed, cancelled, remaining, total, labelOf, approvedBy, payees]);

  const done = steps.filter(s => s.state === 'done').length;
  return <FlowRail steps={steps} eyebrow="Payout journey" label={`Journey of batch ${batch.id}`}
    summary={<>From <b>{labelOf(batch.proposer)}</b> to <b>{batch.payeeCount} recipients</b>, {total}. {done} of {steps.length} steps complete.</>} />;
}

/** Recipient view: one payment from the company treasury to the recipient's own Monad wallet. */
export function PaymentJourney({ payment, withdrawals, me, explorer, loadAnchor }: {
  payment: Payment; withdrawals: Withdrawal[]; me: Address; explorer: string; loadAnchor: () => Promise<FlowAnchor | null>;
}) {
  const anchor = useAnchor(true, payment.batchId, loadAnchor);
  const latest = withdrawals.at(-1);
  const claimed = withdrawals.find(w => w.status === 'claimed');
  const wState: NodeState = !latest ? 'waiting' : latest.status === 'claimed' ? 'done' : 'active';
  const amount = `${money(payment.amount)} pUSDC`;
  const withdrawalLabel = !latest ? 'Not started' : latest.status === 'burned' ? 'Processing' : latest.status === 'posted' ? 'Confirming' : latest.status === 'claimable' ? 'Ready to receive' : 'Completed';
  const wAmount = latest ? `${money(latest.amount || latest.amountIn)} ${latest.kind === 2 ? 'as tUSDT' : 'tUSDC'}` : '';

  const steps: FlowStep[] = useMemo(() => [
    {
      id: 'treasury', icon: Landmark, title: 'Company treasury', subtitle: `Batch #${payment.batchId}`, state: 'done',
      heading: 'Your organisation prepared the payout',
      body: `Finance included you in batch #${payment.batchId}. The batch was encrypted before it left their browser, so the public network never saw your name or your amount.`,
      visibility: 'Finance, approvers and the auditor', visibilityTone: 'staff',
      details: [{ label: 'Batch', value: `#${payment.batchId}` }],
    },
    {
      id: 'approved', icon: ShieldCheck, title: 'Approved', subtitle: 'Two sign-offs', state: 'done', edge: 'sealed',
      heading: 'Two approvers released it',
      body: 'Two separate approvers signed off. The second approval paid every recipient in the batch at once, inside the private settlement domain.',
      visibility: 'Finance, approvers and the auditor', visibilityTone: 'staff',
      details: [{ label: 'Paid in MPSD block', value: payment.domainBlock || '—' }],
    },
    {
      id: 'balance', icon: LockKeyhole, title: 'Your balance', subtitle: amount, state: 'done', edge: 'paid',
      heading: `${amount} arrived privately`,
      body: 'The money sits in your private balance inside MPSD. Only you can read it; your colleagues cannot, and the public network cannot either.',
      visibility: 'Only you', visibilityTone: 'private',
      details: [{ label: 'Amount', value: amount }, { label: 'Received', value: new Date(payment.paidAt).toLocaleString() }],
    },
    {
      id: 'proof', icon: Anchor, title: 'Proof on Monad', subtitle: anchor?.postedOnChain ? `Block ${anchor.resultMonadBlock || anchor.monadBlock}` : 'Posting…',
      state: anchor?.postedOnChain ? 'done' : 'active', edge: 'root',
      heading: 'Your payment can be proven',
      body: 'A fingerprint of the private ledger was posted to Monad. Your receipt proves this exact payment against it, without revealing anyone else’s.',
      visibility: 'Everyone, as a hash only', visibilityTone: 'public',
      details: anchor?.postedOnChain ? [{ label: 'Posted in', value: anchor.resultTx, href: `${explorer}/tx/${anchor.resultTx}`, mono: true }] : [{ label: 'Status', value: 'Waiting for Monad confirmation' }],
    },
    {
      id: 'withdraw', icon: ArrowDownToLine, title: 'Withdrawal', subtitle: withdrawalLabel, state: wState, edge: 'request',
      heading: latest ? `Withdrawal: ${withdrawalLabel.toLowerCase()}` : 'Withdraw whenever you like',
      body: latest
        ? `You asked to withdraw ${wAmount}. The amount was removed from your private balance, then released by the Whale bridge on Monad once the proof was accepted.`
        : 'Use the Withdraw tab to move money to your Monad wallet as tUSDC, or as tUSDT through a swap. The network fee is covered for you.',
      visibility: latest ? 'Everyone sees the final payout on Monad' : 'Only you', visibilityTone: latest ? 'public' : 'private',
      details: latest ? [{ label: 'Amount', value: wAmount }, { label: 'Status', value: withdrawalLabel }] : [{ label: 'Status', value: 'Not started' }],
    },
    {
      id: 'wallet', icon: Wallet, title: 'Your wallet', subtitle: short(me), state: claimed ? 'done' : 'waiting', edge: 'released',
      heading: claimed ? 'The money is in your wallet' : 'Your own Monad wallet',
      body: claimed ? 'The bridge paid your wallet on Monad. From here it is ordinary money: hold it, send it or swap it.' : 'Once you withdraw, the bridge pays this wallet on Monad.',
      visibility: 'Everyone, like any public transfer', visibilityTone: 'public',
      details: [{ label: 'Wallet', value: me, href: `${explorer}/address/${me}`, mono: true }].concat(claimed?.claimTx ? [{ label: 'Payment', value: claimed.claimTx, href: `${explorer}/tx/${claimed.claimTx}`, mono: true }] : []),
    },
  ], [payment, anchor, latest, claimed, wState, amount, withdrawalLabel, wAmount, me, explorer]);

  const firstOpen = steps.findIndex(s => s.state !== 'done');
  return <FlowRail key={payment.batchId} steps={steps} eyebrow="Your money's journey" label={`Journey of your payment from batch ${payment.batchId}`} initial={firstOpen < 0 ? steps.length - 1 : firstOpen}
    summary={<>From your organisation’s treasury to <b>your wallet</b>. {steps.filter(s => s.state === 'done').length} of {steps.length} steps complete.</>} />;
}
