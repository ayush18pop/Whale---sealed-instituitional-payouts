'use client';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Globe, KeyRound, LockKeyhole, Cpu, PenTool, Send, Landmark, Wallet, Monitor, RotateCcw } from 'lucide-react';
import { api, money, short, type Feed, type Status } from '@/lib/whale';
import './live-network.css';

type P = [number, number];
type NodeId = 'browser' | 'relayer' | 'hub' | 'bridge' | 'wallets' | 'operator' | 'evm' | 'committee';
const NODES: Record<NodeId, { x: number; y: number; title: string; sub: string; icon: typeof Globe; dark?: boolean }> = {
  browser: { x: 100, y: 272, title: 'Your browser', sub: 'sign + encrypt', icon: Monitor },
  relayer: { x: 330, y: 122, title: 'Relayer', sub: 'pays the gas', icon: Send },
  hub: { x: 590, y: 122, title: 'Whale Hub', sub: 'public mailbox', icon: Globe },
  bridge: { x: 850, y: 122, title: 'Bridge', sub: 'escrow · release', icon: Landmark },
  wallets: { x: 1085, y: 122, title: 'Wallets', sub: 'tUSDC · tUSDT', icon: Wallet },
  operator: { x: 400, y: 440, title: 'Operator', sub: 'decrypts', icon: KeyRound, dark: true },
  evm: { x: 660, y: 440, title: 'Private EVM', sub: 'runs Treasury', icon: Cpu, dark: true },
  committee: { x: 920, y: 440, title: 'Committee', sub: 'signs 2 of 3', icon: PenTool, dark: true },
};
const W = 150, H = 66;
const EDGES: { id: string; from: NodeId; to: NodeId; pts: P[]; label: string }[] = [
  { id: 'submit', from: 'browser', to: 'relayer', pts: [[175, 272], [222, 272], [222, 122], [255, 122]], label: 'ciphertext' },
  { id: 'post', from: 'relayer', to: 'hub', pts: [[405, 122], [515, 122]], label: 'Hub.submit' },
  { id: 'down', from: 'hub', to: 'operator', pts: [[575, 155], [575, 268], [400, 268], [400, 407]], label: 'sealed batch' },
  { id: 'exec', from: 'operator', to: 'evm', pts: [[475, 440], [585, 440]], label: 'execute' },
  { id: 'sign', from: 'evm', to: 'committee', pts: [[735, 440], [845, 440]], label: 'new state' },
  { id: 'up', from: 'committee', to: 'hub', pts: [[920, 407], [920, 290], [610, 290], [610, 155]], label: 'state root' },
  { id: 'release', from: 'hub', to: 'bridge', pts: [[665, 122], [775, 122]], label: 'proof ok' },
  { id: 'payout', from: 'bridge', to: 'wallets', pts: [[925, 122], [1010, 122]], label: 'payout' },
];
const ROUTES: Record<string, string[]> = { submitted: ['submit', 'post'], included: ['down'], domainBlock: ['exec', 'sign'], resultPosted: ['up'], claimed: ['release', 'payout'] };
const path = (pts: P[]) => 'M' + pts.map(p => p.join(' ')).join(' L');

type Packet = { key: number; pts: P[]; label: string; tone: 'public' | 'private'; delay: number; to: NodeId };
type Row = { key: number; at: number; type: string; pub: string; priv: string; ms?: number; link?: string };

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function describe(e: Feed, status: Status | null, symbol: (a: string) => string): Omit<Row, 'key' | 'at'> | null {
  const ex = status?.explorer || '';
  const txs = (e.txs || []) as { status?: string; receivedToExecutedMs?: number; receivedToPostedMs?: number }[];
  switch (e.type) {
    case 'submitted': return { type: 'submitted', pub: `Hub.submit from relayer ${short(str(e.relayer))} · ${num(e.ciphertextBytes)?.toLocaleString()} bytes of unreadable ciphertext`, priv: 'Sealed batch waiting for the operator', link: ex && `${ex}/tx/${str(e.hubTx)}` };
    case 'included': return { type: 'included', pub: `Included in Monad block ${Number(str(e.monadBlock)).toLocaleString()}`, priv: 'Operator picks it up and decrypts it', ms: num(e.receivedToIncludedMs) ?? undefined };
    case 'domainBlock': {
      const ok = txs.filter(t => t.status === 'executed').length, deps = ((e.deposits as unknown[]) || []).length, pays = num(e.payments) || 0, wds = num(e.withdrawals) || 0;
      const parts = [`${ok} executed`, pays && `${pays} payments`, deps && `${deps} deposit${deps > 1 ? 's' : ''}`, wds && `${wds} withdrawal${wds > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
      return { type: 'domainBlock', pub: 'Nothing. Execution happens inside MPSD, off Monad.', priv: `MPSD block ${str(e.domainBlock)}: ${parts} in ${num(e.execMs)} ms`, ms: txs[0]?.receivedToExecutedMs };
    }
    case 'resultPosted': return { type: 'resultPosted', pub: `Hub.postResult · state root ${short(str(e.stateRoot))} · ${((e.signers as unknown[]) || []).length} signatures`, priv: `Committee signed MPSD block ${str(e.domainBlock)}`, ms: ((e.txs as { receivedToPostedMs?: number }[]) || [])[0]?.receivedToPostedMs, link: ex && `${ex}/tx/${str(e.postTx)}` };
    case 'claimed': return { type: 'claimed', pub: `Bridge paid ${money(str(e.amount))} ${symbol(str(e.token))} to ${short(str(e.payee))}`, priv: `Withdrawal from MPSD block ${str(e.domainBlock)} released`, link: ex && `${ex}/tx/${str(e.tx)}` };
    case 'reset': return { type: 'reset', pub: 'Demo reset', priv: 'Private ledger returned to the opening state' };
    default: return null;
  }
}

export function LiveNetwork({ status: initialStatus, subscribe, history }: { status: Status | null; subscribe: (fn: (e: Feed) => void) => () => void; history: () => Feed[] }) {
  const [status, setStatus] = useState<Status | null>(initialStatus);
  useEffect(() => { let on = true; const t = setInterval(() => { if (document.visibilityState === 'visible') api<Status>('status').then(x => { if (on) setStatus(x); }).catch(() => {}); }, 5000); return () => { on = false; clearInterval(t); }; }, []);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [hits, setHits] = useState<Partial<Record<NodeId, number>>>({});
  const [lat, setLat] = useState<{ exec?: number; posted?: number }>({});
  const [counts, setCounts] = useState({ sub: 0, exec: 0, posted: 0 });
  const seq = useRef(0);
  const st = useRef(status); st.current = status;
  const symbol = (a: string) => (st.current && a.toLowerCase() === st.current.contracts.tUSDT?.toLowerCase() ? 'tUSDT' : 'tUSDC');

  const ingest = (e: Feed, animate: boolean) => {
    const d = describe(e, st.current, symbol);
    if (!d) return;
    setRows(r => [{ ...d, key: ++seq.current, at: Date.now() }, ...r].slice(0, 9));
    if (e.type === 'submitted') setCounts(c => ({ ...c, sub: c.sub + 1 }));
    if (e.type === 'domainBlock') { setCounts(c => ({ ...c, exec: c.exec + ((e.txs as unknown[]) || []).length })); if (d.ms) setLat(l => ({ ...l, exec: d.ms })); }
    if (e.type === 'resultPosted') { setCounts(c => ({ ...c, posted: c.posted + 1 })); if (d.ms) setLat(l => ({ ...l, posted: d.ms })); }
    if (!animate) return;
    const route = ROUTES[e.type]; if (!route) return;
    route.forEach((id, i) => {
      const edge = EDGES.find(x => x.id === id)!;
      const key = ++seq.current;
      const label = e.type === 'submitted' ? `${num(e.ciphertextBytes)?.toLocaleString()} B` : e.type === 'claimed' ? `${money(str(e.amount))}` : edge.label;
      setPackets(p => [...p, { key, pts: edge.pts, label, tone: ['down', 'exec', 'sign'].includes(id) ? 'private' : 'public', delay: i * 0.9, to: edge.to }]);
    });
  };

  useEffect(() => {
    history().slice(-9).forEach(e => ingest(e, false));
    return subscribe(e => ingest(e, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replay = () => {
    const evs = history().filter(e => ROUTES[e.type]).slice(-8);
    evs.forEach((e, i) => setTimeout(() => ingest(e, true), i * 1100));
  };

  const arrive = (pk: Packet) => { setPackets(p => p.filter(x => x.key !== pk.key)); setHits(h => ({ ...h, [pk.to]: (h[pk.to] || 0) + 1 })); };
  const head = status?.monad?.head;

  return (
    <section className="live">
      <div className="live-stats">
        <div><span>Monad block</span><motion.strong key={head} initial={{ opacity: .4 }} animate={{ opacity: 1 }}>{head ? Number(head).toLocaleString() : '—'}</motion.strong><small>public chain head</small></div>
        <div><span>MPSD block</span><strong>{status?.monad?.lastDomainBlock ?? '—'}</strong><small>private blocks proven on Monad</small></div>
        <div><span>Submit → executed</span><strong>{lat.exec ? `${(lat.exec / 1000).toFixed(2)} s` : '—'}</strong><small>last measured, this session</small></div>
        <div><span>Submit → proven on Monad</span><strong>{lat.posted ? `${(lat.posted / 1000).toFixed(2)} s` : '—'}</strong><small>{counts.sub} sent · {counts.exec} executed · {counts.posted} proven</small></div>
      </div>

      <div className="live-map">
        <div className="live-map-head">
          <span className={`live-dot ${status ? 'on' : ''}`} /> {status ? `Live · operator ${status.operator.status}` : 'Connecting to the network'}
          <button onClick={replay} className="live-replay"><RotateCcw size={13} /> Replay recent activity</button>
        </div>
        <svg viewBox="0 0 1200 560" role="img" aria-label="Where MPSD sits: the public Monad chain above, the private settlement domain below">
          <defs>
            <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d5dee5" /></pattern>
            <pattern id="dotsDark" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#2b4a63" /></pattern>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
          </defs>
          <rect width="1200" height="560" fill="url(#dots)" />
          {/* Public band */}
          <rect x="200" y="30" width="980" height="186" rx="22" className="band-public" />
          <text x="226" y="60" className="band-title">MONAD TESTNET · PUBLIC</text>
          <text x="226" y="78" className="band-sub">Anyone can read this layer</text>
          {/* MPSD band */}
          <rect x="200" y="338" width="980" height="200" rx="22" className="band-private" />
          <rect x="200" y="338" width="980" height="200" rx="22" fill="url(#dotsDark)" />
          <g transform="translate(446 362)"><LockKeyhole x={0} y={-12} size={15} color="#9fc2dc" /></g>
          <text x="468" y="368" className="band-title light">MPSD · PRIVATE SETTLEMENT DOMAIN</text>
          <text x="446" y="388" className="band-sub light">Run by the Whale operator · ciphertext in, hashes out</text>
          <text x="1154" y="368" textAnchor="end" className="band-sub light">only hashes leave this box</text>
          {/* Membrane */}
          <line x1="200" x2="1180" y1="277" y2="277" className="membrane" />
          <text x="1166" y="262" textAnchor="end" className="membrane-text">↓ only ciphertext goes down</text>
          <text x="1166" y="304" textAnchor="end" className="membrane-text">↑ only state roots come up</text>

          {EDGES.map(e => {
            const mid = e.pts[Math.floor((e.pts.length - 1) / 2)], nxt = e.pts[Math.floor((e.pts.length - 1) / 2) + 1];
            const lx = (mid[0] + nxt[0]) / 2, ly = (mid[1] + nxt[1]) / 2;
            const dark = ['exec', 'sign'].includes(e.id);
            return <g key={e.id}>
              <path d={path(e.pts)} className={`edge ${dark ? 'dark' : ''}`} />
              <path d={path(e.pts)} className={`edge-flow ${dark ? 'dark' : ''}`} />
              <text x={lx} y={ly - 8} textAnchor="middle" className={`edge-label ${dark ? 'light' : ''}`}>{e.label}</text>
            </g>;
          })}

          {(Object.keys(NODES) as NodeId[]).map(id => {
            const n = NODES[id], Icon = n.icon;
            return <g key={id} transform={`translate(${n.x - W / 2} ${n.y - H / 2})`} className={`node ${n.dark ? 'dark' : ''}`}>
              <AnimatePresence>{hits[id] && <motion.rect key={hits[id]} x={-4} y={-4} width={W + 8} height={H + 8} rx={18} className="node-hit" initial={{ opacity: .9 }} animate={{ opacity: 0 }} transition={{ duration: 1.1 }} />}</AnimatePresence>
              <rect width={W} height={H} rx={14} className="node-box" />
              <rect x={12} y={15} width={36} height={36} rx={10} className="node-icon" />
              <Icon x={21} y={24} size={18} strokeWidth={1.7} className="node-glyph" />
              <text x={58} y={30} className="node-title">{n.title}</text>
              <text x={58} y={47} className="node-sub">{n.sub}</text>
            </g>;
          })}

          {packets.map(pk => {
            const lens = pk.pts.slice(1).map((p, i) => Math.hypot(p[0] - pk.pts[i][0], p[1] - pk.pts[i][1]));
            const total = lens.reduce((a, b) => a + b, 0);
            let acc = 0; const times = [0, ...lens.map(l => (acc += l) / total)];
            return <motion.g key={pk.key} initial={{ x: pk.pts[0][0], y: pk.pts[0][1], opacity: 0 }}
              animate={{ x: pk.pts.map(p => p[0]), y: pk.pts.map(p => p[1]), opacity: 1 }}
              transition={{ duration: 0.4 + total / 340, delay: pk.delay, ease: 'easeInOut', times }}
              onAnimationComplete={() => arrive(pk)}>
              <circle r={13} className={`packet-glow ${pk.tone}`} filter="url(#glow)" />
              <circle r={6} className={`packet ${pk.tone}`} />
              <g transform="translate(10 -22)"><rect width={pk.label.length * 6.6 + 14} height={20} rx={10} className={`packet-tag ${pk.tone}`} /><text x={7} y={14} className="packet-text">{pk.label}</text></g>
            </motion.g>;
          })}
        </svg>
      </div>

      <div className="live-ticker">
        <div className="ticker-col">
          <h4><Globe size={14} /> What Monad shows <em>public</em></h4>
          <AnimatePresence initial={false}>{rows.map(r => <motion.div layout key={r.key} className={`tick ${r.type}`} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <span className={r.type === 'domainBlock' ? 'muted' : ''}>{r.pub}</span>
            {r.link && <a href={r.link} target="_blank" rel="noreferrer" aria-label="View on explorer"><ArrowUpRight size={13} /></a>}
          </motion.div>)}</AnimatePresence>
          {!rows.length && <p className="tick-empty">Waiting for activity. Submit a payout or press Replay.</p>}
        </div>
        <div className="ticker-col dark">
          <h4><LockKeyhole size={14} /> What happens inside MPSD <em>private</em></h4>
          <AnimatePresence initial={false}>{rows.map(r => <motion.div layout key={r.key} className={`tick ${r.type}`} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <span>{r.priv}</span>{r.ms !== undefined && <b>{(r.ms / 1000).toFixed(2)} s</b>}
          </motion.div>)}</AnimatePresence>
        </div>
      </div>
    </section>
  );
}
