'use client';
import { motion } from 'motion/react';
import { ArrowUpRight, Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { money, short } from '@/lib/whale';
import './receipt-check.css';

export type ReceiptData = {
  leaf: { batchId: string; payee: string; amount: string; salt: string; hash?: string };
  proof: string[]; stateRoot: string; domainBlock: string; resultTx: string; resultMonadBlock?: string; monadBlock: string; postedOnChain: boolean;
};
export type ReceiptView = { payee: string; batchId: string; receipt?: ReceiptData; valid?: boolean; rootOnChain?: string; error?: string };

/** Animated, step-by-step receipt verification. Each step reflects a real call that has completed. */
export function ReceiptCheck({ view, explorer, labelOf }: { view: ReceiptView; explorer: string; labelOf: (a: string) => string }) {
  const r = view.receipt;
  const notPosted = r && !r.postedOnChain;
  const steps = [
    { title: 'Fetch the private receipt', body: r ? `Payment of ${money(r.leaf.amount)} pUSDC to ${labelOf(view.payee)} in batch #${view.batchId}` : 'Reading the receipt you are authorised to see', done: !!r },
    { title: 'Rebuild the leaf', body: r ? `Hash of batch, recipient, amount and a secret salt: ${short(r.leaf.hash || '0x')}` : 'The payment is hashed with a secret salt', done: !!r },
    { title: `Walk the Merkle proof`, body: r ? `${r.proof.length} sibling hash${r.proof.length === 1 ? '' : 'es'} lead from your leaf to one root` : 'Combine sibling hashes up to the root', done: view.valid !== undefined },
    { title: 'Compare with the root on Monad', body: r ? `Hub.results(${r.domainBlock}) in Monad block ${Number(r.resultMonadBlock || r.monadBlock).toLocaleString()}` : 'Read the published root from the public Hub', done: view.valid !== undefined },
  ];
  const failed = !!view.error || view.valid === false || notPosted;
  const active = steps.findIndex(s => !s.done);

  return (
    <div className="rc">
      <ol className="rc-steps">
        {steps.map((s, i) => {
          const state = s.done ? 'done' : failed && i === active ? 'fail' : i === active ? 'run' : 'wait';
          return (
            <motion.li key={s.title} className={state} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * .12 }}>
              <span className="rc-dot">{state === 'done' ? <Check size={13} strokeWidth={3} /> : state === 'fail' ? <X size={13} strokeWidth={3} /> : state === 'run' ? <Loader2 size={13} className="rc-spin" /> : i + 1}</span>
              <div><strong>{s.title}</strong><p>{s.body}</p></div>
            </motion.li>
          );
        })}
      </ol>

      {view.valid === true && !notPosted && (
        <motion.div className="rc-result ok" initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', bounce: .35, duration: .5 }}>
          <motion.span className="rc-seal" initial={{ rotate: -30, scale: 0 }} animate={{ rotate: 0, scale: 1 }} transition={{ delay: .15, type: 'spring', bounce: .5 }}><ShieldCheck size={22} /></motion.span>
          <div><strong>Verified on Monad</strong><p>This exact payment is part of the private ledger state that the operators committed to publicly. No other payment was revealed to check it.</p></div>
        </motion.div>
      )}
      {failed && (
        <div className="rc-result bad">
          <span className="rc-seal"><X size={22} /></span>
          <div><strong>{notPosted ? 'Not posted yet' : view.error ? 'Could not verify' : 'Does not match'}</strong>
            <p>{notPosted ? 'The result for this block is still being posted to Monad. Try again in a few seconds.' : view.error || 'The proof does not lead to the root published on Monad.'}</p></div>
        </div>
      )}

      {r && (
        <dl className="rc-facts">
          <div><dt>State root</dt><dd title={r.stateRoot}>{short(r.stateRoot)}</dd></div>
          <div><dt>Root on Monad</dt><dd title={view.rootOnChain}>{view.rootOnChain ? short(view.rootOnChain) : '—'}</dd></div>
          <div><dt>MPSD block</dt><dd>{r.domainBlock}</dd></div>
          <div><dt>Posted in</dt><dd>{r.resultTx ? <a href={`${explorer}/tx/${r.resultTx}`} target="_blank" rel="noreferrer">{short(r.resultTx)} <ArrowUpRight size={11} /></a> : '—'}</dd></div>
        </dl>
      )}
    </div>
  );
}
