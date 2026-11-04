'use client';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, ChevronDown, Check, Loader2, X } from 'lucide-react';
import './tx-tray.css';

export type TrackedTx = {
  id: string; label: string; at: number;
  kind: 'private' | 'public'; // private: goes through MPSD; public: a direct Monad transaction (claim, deposit)
  stage: 0 | 1 | 2 | 3 | 4;     // private: 1 sent, 2 on Monad, 3 executed in MPSD, 4 proven on Monad. public: 4 = confirmed
  failed?: string; ms?: number;
  links: { label: string; href: string }[];
};

const PRIVATE_STAGES = ['Sent', 'On Monad', 'Executed in MPSD', 'Proven on Monad'];

export function TxTray({ txs, onClear }: { txs: TrackedTx[]; onClear: () => void }) {
  const [manual, setOpen] = useState<boolean | null>(null);
  if (!txs.length) return null;
  const live = txs.filter(t => t.stage < 4 && !t.failed).length;
  const open = manual ?? live > 0;
  return (
    <motion.aside className="tray" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} aria-label="Your transactions">
      <button className="tray-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tray-dot ${live ? 'live' : ''}`} />
        <strong>Your transactions</strong>
        <span className="tray-count">{live ? `${live} in progress` : `${txs.length} done`}</span>
        <ChevronDown size={15} className={open ? 'rot' : ''} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="tray-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .2 }}>
            <AnimatePresence initial={false}>
              {txs.map(t => (
                <motion.div layout key={t.id} className="tray-row" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                  <span className={`tray-icon ${t.failed ? 'fail' : t.stage >= 4 ? 'done' : 'run'}`}>
                    {t.failed ? <X size={12} strokeWidth={3} /> : t.stage >= 4 ? <Check size={12} strokeWidth={3} /> : <Loader2 size={12} className="spin" />}
                  </span>
                  <div className="tray-main">
                    <div className="tray-line">
                      <strong>{t.label}</strong>
                      <span className="tray-links">{t.links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noreferrer" title={l.href}>{l.label}<ArrowUpRight size={11} /></a>)}</span>
                    </div>
                    {t.failed ? <small className="tray-fail">{t.failed}</small> : t.kind === 'private' ? (
                      <div className="tray-stages">
                        {PRIVATE_STAGES.map((s, i) => <span key={s} className={t.stage > i ? 'on' : t.stage === i ? 'next' : ''}>{s}</span>)}
                        {t.ms !== undefined && <em>{(t.ms / 1000).toFixed(2)} s</em>}
                      </div>
                    ) : <small>{t.stage >= 4 ? 'Confirmed on Monad' : 'Waiting for Monad'}</small>}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            <button className="tray-clear" onClick={onClear}>Clear</button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
