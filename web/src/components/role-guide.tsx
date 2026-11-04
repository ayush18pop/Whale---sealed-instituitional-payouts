'use client';
import { motion } from 'motion/react';
import { ArrowRight, Check, Eye, EyeOff } from 'lucide-react';
import { money, type Batch, type Payment, type Withdrawal } from '@/lib/whale';
import './role-guide.css';

type Role = 'finance' | 'approver' | 'auditor' | 'payee';
type Action = { label: string; onClick: () => void; primary?: boolean };
type Step = { label: string; done: boolean };

export function RoleGuide(p: {
  role: Role; name: string; batches: Batch[]; threshold?: number; treasuryBalance?: string; balance?: string; payments: Payment[]; withdrawals: Withdrawal[];
  onSwitch: (label: string) => void; onNewPayout: () => void; onReview: (b: Batch) => void; onJourney: () => void; onWithdraw: () => void; onLive: () => void;
}) {
  const pending = p.batches.filter(b => b.status === 'Pending');
  const executed = p.batches.filter(b => b.status === 'Executed');
  const latestPending = pending.at(-1), latestExecuted = executed.at(-1);
  let kicker = '', title = '', body = '', sees = '', hidden = '';
  let steps: Step[] = [], actions: Action[] = [];

  switch (p.role) {
    case 'finance':
      kicker = 'Finance lead'; title = 'You prepare payouts.';
      body = 'Upload who gets paid and how much. The batch is sealed in your browser before it leaves, then two approvers release it.';
      sees = 'The treasury, every batch you propose'; hidden = 'Monad sees sealed envelopes only';
      steps = [
        { label: 'Treasury funded', done: !!p.treasuryBalance && BigInt(p.treasuryBalance) > 0n },
        { label: 'Payout proposed', done: p.batches.length > 0 },
        { label: `Approved by ${p.threshold ?? 2} people`, done: executed.length > 0 },
        { label: 'Recipients paid privately', done: executed.length > 0 },
      ];
      actions = latestPending
        ? [{ label: `Continue as Approver 1`, onClick: () => p.onSwitch('Approver 1'), primary: true }, { label: 'Watch it live', onClick: p.onLive }]
        : [{ label: 'New payout', onClick: p.onNewPayout, primary: true }, ...(latestExecuted ? [{ label: 'See it as Recipient 1', onClick: () => p.onSwitch('Recipient 1') }] : [])];
      break;
    case 'approver':
      kicker = p.name; title = pending.length ? `${pending.length} payout${pending.length > 1 ? 's' : ''} waiting for you.` : 'Nothing waiting for you.';
      body = `Payouts move only when ${p.threshold ?? 2} of 3 approvers agree. Your approval is signed and sealed like any other transaction, and the second approval pays everyone at once.`;
      sees = 'Every batch total and recipient list'; hidden = 'Monad sees only that someone approved';
      steps = latestPending ? [
        { label: 'Review the recipients', done: false },
        { label: `Approve · ${latestPending.approvals} of ${p.threshold ?? 2} so far`, done: latestPending.approvals >= 1 && p.name === 'Approver 2' },
        { label: 'Payout releases automatically', done: false },
      ] : [{ label: 'You are all caught up', done: true }];
      actions = latestPending
        ? [{ label: `Review batch #${latestPending.id}`, onClick: () => p.onReview(latestPending), primary: true }, { label: p.name === 'Approver 1' ? 'Continue as Approver 2' : 'Continue as Approver 1', onClick: () => p.onSwitch(p.name === 'Approver 1' ? 'Approver 2' : 'Approver 1') }]
        : latestExecuted ? [{ label: 'See it as Recipient 1', onClick: () => p.onSwitch('Recipient 1'), primary: true }, { label: 'Audit it', onClick: () => p.onSwitch('Auditor') }] : [{ label: 'Back to Finance', onClick: () => p.onSwitch('Finance') }];
      break;
    case 'auditor':
      kicker = 'Auditor'; title = 'You can see everything, and prove it.';
      body = 'Every payment is anchored to a fingerprint published on Monad. Pick any line and check it against the public record yourself.';
      sees = 'All batches and every recipient line'; hidden = 'Nobody outside sees what you see';
      steps = [{ label: `${p.batches.length} batch${p.batches.length === 1 ? '' : 'es'} on record`, done: p.batches.length > 0 }, { label: `${executed.length} paid and anchored on Monad`, done: executed.length > 0 }, { label: 'Verify a receipt', done: false }];
      actions = latestExecuted ? [{ label: `Open batch #${latestExecuted.id} to verify`, onClick: () => p.onReview(latestExecuted), primary: true }, { label: 'Watch it live', onClick: p.onLive }] : [{ label: 'Watch it live', onClick: p.onLive, primary: true }];
      break;
    case 'payee': {
      const paid = p.payments.reduce((n, x) => n + BigInt(x.amount), 0n);
      const w = p.withdrawals.at(-1);
      kicker = p.name; title = p.payments.length ? `You were paid ${money(paid.toString())} pUSDC.` : 'Nothing has arrived yet.';
      body = 'Your pay lives in a private balance only you can read. Withdraw it to your own Monad wallet whenever you like; the network fee is covered.';
      sees = 'Only your own payments'; hidden = 'Colleagues cannot see your pay, and you cannot see theirs';
      steps = [{ label: 'Payment received privately', done: p.payments.length > 0 }, { label: 'Proof anchored on Monad', done: p.payments.length > 0 }, { label: w ? `Withdrawal ${w.status}` : 'Withdraw to your wallet', done: w?.status === 'claimed' }];
      actions = [{ label: 'See your payment journey', onClick: p.onJourney, primary: true }, { label: 'Withdraw', onClick: p.onWithdraw }];
      break;
    }
  }

  return (
    <motion.section className={`guide guide-${p.role}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .4, ease: 'easeOut' }}>
      <svg className="guide-wave" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 70 C 200 30, 400 110, 600 70 S 1000 30, 1200 70" />
        <path d="M0 85 C 220 50, 420 120, 620 85 S 1020 50, 1200 85" />
      </svg>
      <div className="guide-main">
        <span className="guide-kicker">{kicker}</span>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="guide-actions">
          {actions.map(a => <button key={a.label} className={a.primary ? 'primary' : ''} onClick={a.onClick}>{a.label}{a.primary && <ArrowRight size={15} />}</button>)}
        </div>
      </div>
      <div className="guide-side">
        <ol className="guide-steps">
          {steps.map((s, i) => (
            <motion.li key={s.label} className={s.done ? 'done' : ''} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .1 + i * .07 }}>
              <span>{s.done ? <Check size={12} strokeWidth={3} /> : i + 1}</span>{s.label}
            </motion.li>
          ))}
        </ol>
        <div className="guide-sees"><Eye size={13} /> <span><b>You see</b> {sees}</span></div>
        <div className="guide-sees"><EyeOff size={13} /> <span>{hidden}</span></div>
      </div>
    </motion.section>
  );
}
