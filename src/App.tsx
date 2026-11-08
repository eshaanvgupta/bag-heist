import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boardHash, checkRoute, solveRoutes, type Board } from './engine/rules';
import { findDrafts, importBackup, makeDraft, saveDraft, type RevealDraft } from './drafts';
import { loadTestnetEvidence, releaseEvidence, type TestnetEvidence } from './evidence';
import { clearPending, connectWallet, currentAccount, disconnectWallet, loadSnapshot, pendingTransaction, sendTransaction, transactionStatus } from './live';
import { Practice } from './practice';
import { bag, near, phaseOf, short, type Mode, type Phase, type Snapshot, type TxNotice } from './types';
import deployment from '../public/evidence/deployment.json';

const LIVE_CONTRACT = import.meta.env.VITE_NEAR_CONTRACT_ID || deployment.contract_id;
const ONE_YOCTO = '1';
const MODE_COPY: Record<Mode, { label: string; kicker: string; copy: string }> = {
  practice: { label: 'Practice floor', kicker: 'Local simulation', copy: 'Run the complete economy in your browser with an accelerated chain clock.' },
  testnet: { label: 'Testnet vault', kicker: 'Wallet signed', copy: 'Read finalized NEAR state and sign each game action with your own testnet wallet.' },
  replay: { label: 'Evidence room', kicker: 'Read only', copy: 'Inspect the compiled contract, parity corpus, and recorded chain receipts without broadcasting.' },
};

function countdown(round: Snapshot['round'], now: bigint, phase: Phase): string {
  if (!round || phase === 'finalized') return 'settled';
  if (phase === 'settle') return 'ready';
  const target = BigInt(phase === 'commit' ? round.commitment_end : round.reveal_end);
  const seconds = target > now ? Number((target - now + 999_999_999n) / 1_000_000_000n) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function moveBetween(from: number, to: number): string | null {
  if (to === from - 6) return 'U'; if (to === from + 6) return 'D';
  if (Math.floor(from / 6) === Math.floor(to / 6) && to === from - 1) return 'L';
  if (Math.floor(from / 6) === Math.floor(to / 6) && to === from + 1) return 'R';
  return null;
}

function Badge({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'gold' | 'green' | 'red' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function VaultBoard({ board, moves, crowbar, onTile }: { board: Board; moves: string; crowbar: boolean; onTile: (tile: number) => void }) {
  const result = checkRoute(board, moves, crowbar);
  const order = new Map(result.path.map((tile, index) => [tile, index]));
  return <div className="board-wrap">
    <div className="board" role="grid" aria-label="Six by six vault floor">
      {board.tiles.map((kind, tile) => {
        const step = order.get(tile), visited = step !== undefined;
        const className = ['tile', kind === 1 ? 'wall' : kind === 2 ? 'door' : 'open', tile === board.start ? 'start' : '', tile === board.exit ? 'exit' : '', visited ? 'visited' : ''].filter(Boolean).join(' ');
        return <button key={tile} className={className} onClick={() => onTile(tile)} disabled={kind === 1} role="gridcell" aria-label={`Tile ${tile}${tile === board.start ? ', start' : tile === board.exit ? ', exit' : kind === 1 ? ', wall' : kind === 2 ? ', locked door' : ''}${board.loot[tile] ? `, loot ${board.loot[tile]}` : ''}`}>
          <span className="tile-index">{String(tile).padStart(2, '0')}</span>
          {tile === board.start ? <b>IN</b> : tile === board.exit ? <b>OUT</b> : kind === 1 ? <i /> : kind === 2 ? <b className="door-mark">LOCK</b> : board.loot[tile] > 0 ? <b className="loot">{board.loot[tile]}</b> : null}
          {visited && <span className="route-step">{step}</span>}
        </button>;
      })}
    </div>
    <div className="board-legend"><span><i className="swatch loot-swatch" /> loot</span><span><i className="swatch door-swatch" /> locked</span><span><i className="swatch path-swatch" /> route</span></div>
  </div>;
}

function EvidenceRoom({ evidence, error }: { evidence: TestnetEvidence | null; error: string }) {
  const build = releaseEvidence.wasm;
  return <section className="evidence-layout">
    <div className="evidence-hero panel">
      <div><p className="eyebrow">Release artifact</p><h2>The rules are executable</h2><p>The optimized contract is compiled from the reviewed Rust source, checked for its required NEAR exports, and replayed against a shared Rust and TypeScript corpus.</p></div>
      <div className="seal"><span>WASM</span><strong>{(build.bytes / 1024).toFixed(1)}</strong><small>KiB · MVP validated</small></div>
    </div>
    <div className="proof-grid">
      <Metric label="Contract digest" value={short(build.sha256, 10)} detail="SHA-256" />
      <Metric label="WASM exports" value={String(build.exports)} detail="public ABI" />
      <Metric label="Board vectors" value={String(releaseEvidence.boards)} detail="deterministic generation" />
      <Metric label="Route cases" value={String(releaseEvidence.namedRoutes + releaseEvidence.differentialRoutes)} detail="shared differential corpus" />
    </div>
    <div className="panel proof-panel">
      <div className="panel-head"><div><p className="eyebrow">Recorded NEAR receipts</p><h3>{evidence ? `${evidence.transactions.length} transactions` : 'Deployment evidence slot'}</h3></div><Badge tone={evidence ? 'green' : 'gold'}>{evidence ? 'verified file' : 'release ready'}</Badge></div>
      {evidence ? <>
        <dl className="identity"><div><dt>Contract</dt><dd>{evidence.contract_id}</dd></div><div><dt>Code hash</dt><dd>{short(evidence.code_hash, 12)}</dd></div><div><dt>Source</dt><dd>{short(evidence.source_commit, 12)}</dd></div></dl>
        <div className="receipt-list">{evidence.transactions.map(tx => <a key={tx.hash} href={tx.explorer_url} target="_blank" rel="noreferrer"><span>{tx.method}</span><code>{short(tx.hash)}</code><Badge tone={tx.outcome === 'success' ? 'green' : 'red'}>{tx.outcome}</Badge></a>)}</div>
      </> : <p className="quiet">The verifier loads a public evidence bundle only when its contract identity, WASM digest, transaction hashes, and outcomes satisfy the release schema. The playable practice economy and compiled-WASM checks remain available independently.</p>}
      {error && <p className="error-line">Evidence check: {error}</p>}
    </div>
  </section>;
}

export default function App() {
  const practice = useRef<Practice | null>(null);
  if (!practice.current) practice.current = new Practice();
  const [mode, setMode] = useState<Mode>(() => sessionStorage.getItem('bag-heist:mode') === 'practice' ? 'practice' : 'testnet');
  const currentMode = useRef(mode);
  currentMode.current = mode;
  const [started, setStarted] = useState(() => sessionStorage.getItem('bag-heist:started') === 'yes');
  const [liveReady, setLiveReady] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [account, setAccount] = useState('you.testnet');
  const [contractId, setContractId] = useState(() => LIVE_CONTRACT || localStorage.getItem('bag-heist:contract') || '');
  const [snapshot, setSnapshot] = useState<Snapshot>(() => practice.current!.snapshot('you.testnet'));
  const [moves, setMoves] = useState('');
  const [useCrowbar, setUseCrowbar] = useState(false);
  const [draft, setDraft] = useState<RevealDraft | null>(null);
  const [notice, setNotice] = useState<TxNotice>({ state: 'idle', message: 'Select adjacent tiles to plan your route.' });
  const [tick, setTick] = useState(0);
  const [evidence, setEvidence] = useState<TestnetEvidence | null>(null);
  const [evidenceError, setEvidenceError] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const refreshPractice = useCallback((roundId?: string) => setSnapshot(practice.current!.snapshot(account, roundId)), [account]);
  const refreshLive = useCallback(async () => {
    if (!contractId) throw new Error('Enter the deployed .testnet contract account.');
    const walletAccount = await currentAccount();
    const next = await loadSnapshot(contractId, walletAccount);
    if (currentMode.current !== 'testnet') return;
    setAccount(walletAccount || '');
    setSnapshot(next); setLiveReady(true);
  }, [contractId]);

  useEffect(() => { const id = setInterval(() => setTick(value => value + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { loadTestnetEvidence().then(setEvidence).catch(error => setEvidenceError(error instanceof Error ? error.message : String(error))); }, []);
  useEffect(() => {
    sessionStorage.setItem('bag-heist:mode', mode);
    if (mode === 'practice') { setAccount('you.testnet'); setSnapshot(practice.current!.snapshot('you.testnet')); }
    if (mode === 'testnet') {
      setLiveReady(false); setAccount('');
      currentAccount().then(value => { if (currentMode.current === 'testnet') setAccount(value || ''); }).catch(() => {});
      if (contractId) refreshLive().catch(error => setNotice({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) }));
    }
  }, [mode, refreshLive, contractId]);
  useEffect(() => {
    if (mode !== 'testnet') return;
    const pending = pendingTransaction();
    const returned = new URLSearchParams(window.location.search).get('transactionHashes')?.split(',')[0];
    if (!pending || (!pending.hash && !returned)) return;
    transactionStatus(returned || pending.hash!, pending.accountId).then(status => {
      setNotice({ state: status.status, message: status.message, hash: status.hash });
      if (status.status === 'confirmed' || status.status === 'failed') clearPending();
      if (status.status === 'confirmed' && contractId) refreshLive().catch(() => {});
      window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    });
  }, [mode, contractId, refreshLive]);
  useEffect(() => {
    if (mode !== 'testnet' || !liveReady) return;
    const timer = setInterval(() => refreshLive().catch(error => setNotice({ state: 'unavailable', message: error.message })), 12_000);
    return () => clearInterval(timer);
  }, [mode, liveReady, refreshLive]);
  useEffect(() => {
    const round = snapshot.round;
    if (!round || !snapshot.account) { setDraft(null); return; }
    const recovered = findDrafts({ contractId: snapshot.config.contract_id, playerId: snapshot.account, roundId: round.id }).find(value => !snapshot.commitment || value.commitmentHash === snapshot.commitment.commitment_hash) ?? null;
    setDraft(recovered); if (recovered) { setMoves(recovered.moves); setUseCrowbar(recovered.useCrowbar); }
  }, [snapshot.round?.id, snapshot.account, snapshot.config.contract_id, snapshot.commitment?.commitment_hash]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!started || mode === 'replay') return;
      if ((event.target as HTMLElement).matches('input, textarea, button')) return;
      const key: Record<string, string> = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };
      if (key[event.key]) { event.preventDefault(); addMove(key[event.key]); }
      if (event.key === 'Backspace') { event.preventDefault(); setMoves(value => value.slice(0, -1)); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });

  const round = mode === 'testnet' && !liveReady ? null : snapshot.round;
  const now = BigInt(snapshot.economy.block_timestamp) + BigInt(Math.max(0, Date.now() - snapshot.receivedAt)) * 1_000_000n + BigInt(tick - tick);
  const phase = round ? phaseOf(round, now) : 'finalized';
  const result = useMemo(() => round ? checkRoute(round.board, moves, useCrowbar) : null, [round, moves, useCrowbar]);
  const scouted = useMemo(() => round ? solveRoutes(round.board, useCrowbar, 120_000)[0] : null, [round?.id, useCrowbar]);
  const boardVerified = round ? boardHash(round.board) === round.board_hash : false;
  const profile = snapshot.profile;

  function addMove(move: string) {
    if (!started || !round || moves.length >= 35 || snapshot.commitment) return;
    const candidate = moves + move, check = checkRoute(round.board, candidate, useCrowbar);
    if (['WALL', 'REVISIT', 'DOOR_LOCKED', 'SECOND_DOOR', 'OUT_OF_BOUNDS', 'PAST_EXIT', 'BAD_MOVE'].includes(check.verdict)) {
      setNotice({ state: 'failed', message: `Route stopped: ${check.verdict.replaceAll('_', ' ').toLowerCase()}.` }); return;
    }
    setMoves(candidate); setNotice({ state: 'idle', message: check.valid ? 'Exit reached. This route is ready to seal.' : 'Route updated.' });
  }
  function selectTile(tile: number) {
    if (!round || !result) return;
    const existing = result.path.indexOf(tile);
    if (existing >= 0) { setMoves(moves.slice(0, existing)); return; }
    const move = moveBetween(result.path.at(-1)!, tile);
    if (move) addMove(move);
  }
  function mutate(label: string, action: () => void) {
    try { action(); refreshPractice(); setNotice({ state: 'confirmed', message: label }); }
    catch (error) { setNotice({ state: 'failed', message: error instanceof Error ? error.message : String(error) }); }
  }
  function startHeist() {
    if (mode === 'practice' && !snapshot.round) practice.current!.open();
    if (mode === 'practice') refreshPractice();
    setStarted(true); sessionStorage.setItem('bag-heist:started', 'yes');
    requestAnimationFrame(() => document.getElementById('vault-game')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  async function connect() {
    setMode('testnet'); sessionStorage.setItem('bag-heist:mode', 'testnet');
    setWalletBusy(true);
    setNotice({ state: 'signing', message: 'Connect your NEAR testnet wallet to enter the live vault.' });
    try {
      localStorage.setItem('bag-heist:contract', contractId);
      const connected = await connectWallet(contractId);
      setAccount(connected || '');
      if (contractId) await refreshLive();
    } catch (error) { setNotice({ state: 'failed', message: error instanceof Error ? error.message : 'Wallet connection was cancelled.' }); }
    finally { setWalletBusy(false); }
  }
  async function liveAction(method: string, args: object = {}, deposit = '0') {
    if (!account || !liveReady || snapshot.config.contract_id !== contractId) { setNotice({ state: 'failed', message: 'Connect your wallet and load the live contract first.' }); return; }
    setNotice({ state: 'signing', message: `Review ${method} in your wallet.` });
    try {
      const tx = await sendTransaction({ contractId, accountId: account, method, args, deposit }, hash => setNotice({ state: 'pending', message: 'Transaction submitted. Waiting for finality.', hash }));
      if (tx) setNotice({ state: tx.status, message: tx.message, hash: tx.hash });
      if (tx?.status === 'confirmed') await refreshLive();
    } catch (error) { setNotice({ state: 'failed', message: error instanceof Error ? error.message : 'Wallet request rejected.' }); }
  }
  function createDraft(): RevealDraft {
    if (!round || !snapshot.account || !result?.valid) throw new Error('Finish a valid route before committing.');
    if (!boardVerified) throw new Error('The browser board hash does not match the round record.');
    const next = makeDraft({ contractId: snapshot.config.contract_id, playerId: snapshot.account, roundId: round.id, boardHash: round.board_hash, useCrowbar, moves });
    saveDraft(next); setDraft(next); return next;
  }
  async function commit() {
    try {
      const next = createDraft();
      if (mode === 'practice') mutate('Commitment sealed. Your reveal backup was saved first.', () => practice.current!.commit(account, next));
      else await liveAction('commit_solution', { round_id: round!.id, commitment_hash: next.commitmentHash, use_crowbar: next.useCrowbar }, snapshot.config.commitment_deposit);
    } catch (error) { setNotice({ state: 'failed', message: error instanceof Error ? error.message : String(error) }); }
  }
  async function reveal() {
    if (!draft || !round || !snapshot.commitment) { setNotice({ state: 'failed', message: 'Recover the matching reveal backup first.' }); return; }
    try {
      if (mode === 'practice') mutate('Matching route revealed and scored.', () => practice.current!.reveal(account, draft));
      else await liveAction('reveal_solution', { round_id: round.id, moves: draft.moves, salt: draft.salt });
    } catch (error) { setNotice({ state: 'failed', message: error instanceof Error ? error.message : String(error) }); }
  }
  function exportDraft() {
    if (!draft) return; const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }));
    link.download = `bag-heist-${draft.roundId}-${draft.commitmentHash.slice(0, 8)}.json`; link.click(); URL.revokeObjectURL(link.href);
  }
  async function importDraftFile(file?: File) {
    if (!file || !round || !snapshot.account || !snapshot.commitment) return;
    try {
      const next = importBackup(await file.text(), { contractId: snapshot.config.contract_id, playerId: snapshot.account, roundId: round.id, board: round.board, commitmentHash: snapshot.commitment.commitment_hash });
      setDraft(next); setMoves(next.moves); setUseCrowbar(next.useCrowbar); setNotice({ state: 'confirmed', message: 'Reveal backup verified against wallet, board, round, and chain commitment.' });
    } catch (error) { setNotice({ state: 'failed', message: error instanceof Error ? error.message : String(error) }); }
  }

  const action = (() => {
    if (mode === 'replay') return null;
    if (mode === 'testnet' && !account) return <button className="primary" onClick={connect}>Connect wallet to play</button>;
    if (!profile) return <button className="primary" onClick={() => mode === 'practice' ? mutate('Game profile registered.', () => practice.current!.register(account)) : liveAction('register_profile', {}, snapshot.config.profile_deposit)}>Register heist profile</button>;
    if (!snapshot.ftRegistered) return <button className="primary" onClick={() => mode === 'practice' ? mutate('BAG storage registered.', () => practice.current!.registerFt(account)) : liveAction('storage_deposit', { account_id: snapshot.account, registration_only: true }, '1250000000000000000000')}>Register BAG storage</button>;
    if (phase === 'commit' && !snapshot.commitment) return <button className="primary" disabled={!result?.valid} onClick={commit}>Seal this route</button>;
    if (phase === 'commit' && snapshot.commitment) return <button className="primary" disabled={mode !== 'practice'} onClick={() => mode === 'practice' && mutate('Chain clock advanced to reveal.', () => practice.current!.advance())}>{mode === 'practice' ? 'Close commitment window' : 'Commitment sealed'}</button>;
    if (phase === 'reveal' && !snapshot.commitment) return <button className="primary" disabled={mode !== 'practice'} onClick={() => mutate('Chain clock advanced to settlement.', () => practice.current!.advance())}>{mode === 'practice' ? 'Close reveal window' : 'Next round after settlement'}</button>;
    if (phase === 'reveal' && !snapshot.commitment?.reveal) return <button className="primary" disabled={!draft} onClick={reveal}>Reveal matching route</button>;
    if (phase === 'reveal') return <button className="primary" disabled={mode !== 'practice'} onClick={() => mode === 'practice' && mutate('Chain clock advanced to settlement.', () => practice.current!.advance())}>{mode === 'practice' ? 'Close reveal window' : 'Reveal recorded'}</button>;
    if (phase === 'settle') return <button className="primary" onClick={() => mode === 'practice' ? mutate('Round finalized by the game engine.', () => practice.current!.finalize()) : liveAction('finalize_round', { round_id: round!.id })}>Finalize round</button>;
    if (round?.winner === snapshot.account && !round.claimed) return <button className="primary" onClick={() => mode === 'practice' ? mutate('100 BAG moved from treasury to winner.', () => practice.current!.claim(account, round.id)) : liveAction('claim_reward', { round_id: round.id }, ONE_YOCTO)}>Claim 100 BAG</button>;
    return <button className="primary" onClick={() => mode === 'practice' ? mutate('Next vault opened and 100 BAG reserved.', () => practice.current!.open()) : liveAction('open_round', {}, snapshot.config.round_deposit)}>Open next vault</button>;
  })();

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="BAG HEIST home"><span className="brand-mark">BH</span><span><strong>BAG HEIST</strong><small>Every move has a price.</small></span></a>
      <nav className="mode-switch" aria-label="Application mode">{(Object.keys(MODE_COPY) as Mode[]).map(value => <button key={value} className={mode === value ? 'active' : ''} onClick={() => { setMode(value); setMoves(''); }}><span>{MODE_COPY[value].kicker}</span>{MODE_COPY[value].label}</button>)}</nav>
      <div className="header-actions"><div className="chain-status"><i className={mode === 'testnet' && liveReady ? 'live' : ''} /><span>{mode === 'testnet' ? 'NEAR testnet' : mode === 'practice' ? 'local engine' : 'read only'}</span></div><button className="secondary wallet-button" disabled={walletBusy} onClick={connect}>{walletBusy ? 'Connecting…' : mode === 'testnet' && account ? short(account, 6) : 'Connect wallet'}</button></div>
    </header>

    <main id="top">
      <section className="masthead">
        <div><p className="eyebrow">{MODE_COPY[mode].kicker}</p><h1>Plan quiet.<br/><em>Leave heavy.</em></h1><p className="lede">{MODE_COPY[mode].copy}</p></div>
        <div className="round-stamp"><span>ROUND</span><strong>{round?.id ? String(round.id).padStart(2, '0') : '—'}</strong><small>{round?.template_name || 'vault unopened'}</small></div>
      </section>

      {mode === 'replay' ? <EvidenceRoom evidence={evidence} error={evidenceError} /> : <>
        {!started && <section className="start-panel panel"><div className="start-copy"><p className="eyebrow">The vault is waiting</p><h2>Your heist. Your first move.</h2><p>Find the loot. Seal your route. Make it out with the bag.</p><div className="start-facts"><span><b>100 BAG</b> round prize</span><span><b>6 × 6</b> vault floor</span><span><b>120 seconds</b> to commit</span></div></div><div className="start-actions"><button className="primary" onClick={startHeist}>Start heist</button><button className="secondary" disabled={walletBusy} onClick={connect}>Play with a NEAR wallet</button><small>{mode === 'practice' ? 'Practice starts when you do. No wallet required.' : 'Live rounds follow the shared chain schedule.'}</small></div></section>}
        {mode === 'testnet' && <section className="connection-bar panel">
          <label><span>Contract account</span><input value={contractId} onChange={event => setContractId(event.target.value.trim())} placeholder="your-contract.testnet" /></label>
          <div className="connection-actions">
            <button className="secondary" onClick={() => refreshLive().catch(error => setNotice({ state: 'unavailable', message: error.message }))}>Refresh chain</button>
            {account ? <button className="secondary" onClick={() => disconnectWallet().then(() => { setAccount(''); if (contractId) return refreshLive(); })}>Disconnect {short(account, 5)}</button> : <span className="wallet-hint">Connect using the wallet button above</span>}
          </div>
        </section>}

        {mode === 'testnet' && !liveReady ? started && <section className="panel live-gate"><p className="eyebrow">NEAR testnet</p><h2>Opening the live vault</h2><p role="status">{notice.state === 'unavailable' || notice.state === 'failed' ? notice.message : 'Fetching the latest round, treasury, and player state from NEAR.'}</p></section> : started ? <div id="vault-game">
        <section className="economy-strip">
          <Metric label="Prize reserve" value={`${round ? bag(round.prize) : '0'} BAG`} detail="fixed per round" />
          <Metric label="Current supply" value={`${bag(snapshot.economy.total_supply)} BAG`} detail={`burned ${bag(BigInt(snapshot.config.initial_supply) - BigInt(snapshot.economy.total_supply))}`} />
          <Metric label="Your balance" value={`${bag(snapshot.balance)} BAG`} detail={snapshot.account || 'wallet disconnected'} />
          <Metric label="Crowbars" value={String(profile?.crowbars ?? 0)} detail="one locked door each" />
        </section>

        <section className="game-layout">
          <article className="panel board-panel">
            <div className="panel-head">
              <div><p className="eyebrow">Public vault plan</p><h2>{round?.template_name || 'No active round'}</h2></div>
              <div className="phase-lockup"><span>{phase === 'settle' ? 'finalize' : phase}</span><strong>{countdown(round, now, phase)}</strong><small>chain schedule</small></div>
            </div>
            {round && <VaultBoard board={round.board} moves={moves} crowbar={useCrowbar} onTile={selectTile} />}
            <div className="hash-line"><span>Board integrity</span><Badge tone={boardVerified ? 'green' : 'red'}>{boardVerified ? 'hash matched' : 'hash mismatch'}</Badge><code>{round ? short(round.board_hash, 11) : '—'}</code></div>
          </article>

          <aside className="control-column">
            <section className="panel route-panel">
              <div className="panel-head"><div><p className="eyebrow">Your route</p><h3>{result?.valid ? 'Exit secured' : 'Plot the line'}</h3></div><Badge tone={result?.valid ? 'green' : moves ? 'gold' : 'plain'}>{result?.verdict || 'waiting'}</Badge></div>
              <div className="route-code">{moves || <span>Use the board, arrow keys, or controls.</span>}</div>
              <div className="route-stats"><Metric label="Loot" value={String(result?.loot ?? 0)} /><Metric label="Length" value={`${result?.length ?? 0}/35`} /><Metric label="Doors" value={`${result?.doors ?? 0}/1`} /></div>
              <div className="dpad" aria-label="Route controls"><span/><button onClick={() => addMove('U')}>U</button><span/><button onClick={() => addMove('L')}>L</button><button onClick={() => addMove('D')}>D</button><button onClick={() => addMove('R')}>R</button></div>
              <div className="route-tools"><button className="text-button" onClick={() => setMoves(value => value.slice(0, -1))}>Undo</button><button className="text-button" onClick={() => setMoves('')}>Clear</button><button className="text-button" disabled={!scouted} onClick={() => scouted && setMoves(scouted.moves)}>Scout route</button></div>
              <label className={`crowbar-toggle ${useCrowbar ? 'selected' : ''}`}><input type="checkbox" checked={useCrowbar} disabled={!profile?.crowbars || !!snapshot.commitment} onChange={event => setUseCrowbar(event.target.checked)} /><span className="crowbar-icon">/</span><span><b>Carry a crowbar</b><small>Consumed when the commitment succeeds, even if you never reveal.</small></span></label>
            </section>

            <section className="panel action-panel">
              <div className="panel-head"><div><p className="eyebrow">Next move</p><h3>{phase === 'commit' ? 'Seal your plan' : phase === 'reveal' ? 'Open the envelope' : phase === 'settle' ? 'Settle the vault' : 'Collect or continue'}</h3></div><span className={`notice-dot ${notice.state}`} /></div>
              <fieldset className="transaction-action" disabled={notice.state === 'signing' || notice.state === 'pending'}>{action}</fieldset>
              <p className="action-fee">{!profile ? `One-time game storage: ${near(snapshot.config.profile_deposit)} NEAR` : !snapshot.ftRegistered ? 'One-time token storage: 0.00125 NEAR' : phase === 'commit' && !snapshot.commitment ? `Commitment storage: ${near(snapshot.config.commitment_deposit)} NEAR` : 'Your wallet shows the transaction fee before approval.'}</p>
              <p className={`notice ${notice.state}`}>{notice.message}</p>
              {notice.hash && <a className="tx-link" href={`https://testnet.nearblocks.io/txns/${notice.hash}`} target="_blank" rel="noreferrer">View transaction {short(notice.hash)}</a>}
              {snapshot.commitment && <div className="commit-card"><span>Sealed hash</span><code>{short(snapshot.commitment.commitment_hash, 12)}</code><small>Sequence #{snapshot.commitment.sequence}</small></div>}
              <div className="backup-actions"><button className="secondary" disabled={!draft} onClick={exportDraft}>Export reveal</button><button className="secondary" disabled={!snapshot.commitment} onClick={() => importRef.current?.click()}>Import reveal</button><input ref={importRef} hidden type="file" accept="application/json" onChange={event => importDraftFile(event.target.files?.[0])} /></div>
            </section>

            <section className="panel workshop">
              <div><p className="eyebrow">Tool workshop</p><h3>Burn BAG. Bend steel.</h3><p>A crafted crowbar costs 5 BAG and opens one locked door in a later raid.</p></div>
              <button className="secondary" disabled={!profile || BigInt(snapshot.balance) < BigInt(snapshot.config.crowbar_price) || profile.crowbars >= 10} onClick={() => mode === 'practice' ? mutate('5 BAG burned; crowbar added to inventory.', () => practice.current!.craft(account)) : liveAction('craft_crowbar', {}, ONE_YOCTO)}>Craft for 5 BAG</button>
            </section>
          </aside>
        </section>

        <section className="lower-grid">
          <div className="panel"><div className="panel-head"><div><p className="eyebrow">Current field</p><h3>Best valid submission</h3></div><Badge tone={round?.best ? 'gold' : 'plain'}>{round?.valid_reveals || 0} valid</Badge></div>
            {round?.best ? <div className="winner-line"><strong>{round.best.player_id}</strong><span>{round.best.loot} loot</span><span>{round.best.length} moves</span><span>sequence #{round.best.sequence}</span></div> : <p className="quiet">The contract updates this record during each matching reveal. Finalization stays constant time.</p>}
          </div>
          <div className="panel audit-panel"><div className="panel-head"><div><p className="eyebrow">Treasury audit</p><h3>Economic invariants</h3></div><Badge tone={snapshot.economy.budget_identity_holds && snapshot.economy.treasury_covers_budget && snapshot.economy.supply_audit_holds ? 'green' : 'red'}>contract reported</Badge></div>
            <div className="audit-list"><span><i className={snapshot.economy.budget_identity_holds ? 'pass' : ''}/>Budget identity</span><span><i className={snapshot.economy.treasury_covers_budget ? 'pass' : ''}/>Treasury coverage</span><span><i className={snapshot.economy.supply_audit_holds ? 'pass' : ''}/>Supply audit</span></div>
          </div>
        </section>
        {snapshot.rounds.some(value => value.winner === snapshot.account && value.finalized && !value.claimed && value.id !== round?.id) && <section className="panel prize-inbox"><p className="eyebrow">Your prize inbox</p>{snapshot.rounds.filter(value => value.winner === snapshot.account && value.finalized && !value.claimed && value.id !== round?.id).map(value => <div key={value.id}><span>Round {value.id} · 100 BAG ready to collect</span><button className="secondary" disabled={!snapshot.ftRegistered} onClick={() => mode === 'practice' ? mutate('100 BAG moved from treasury to winner.', () => practice.current!.claim(account, value.id)) : liveAction('claim_reward', { round_id: value.id }, ONE_YOCTO)}>Claim round {value.id}</button></div>)}</section>}
        </div> : null}
      </>}
    </main>

    <footer><div><strong>BAG HEIST</strong><span>Memecoins With Mechanics · Games With Real Economies</span></div><div><a href="https://github.com/eshaanvgupta/bag-heist" target="_blank" rel="noreferrer">Source</a><a href="https://docs.near.org/" target="_blank" rel="noreferrer">NEAR docs</a><span>MIT · 2026</span></div></footer>
  </div>;
}
