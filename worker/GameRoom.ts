/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import randomColor from 'randomcolor';
import type { Env } from './types';
import type { GameConfig, GameState, Player, Cell, PendingActions } from './types';
import { generateGrid } from './grid';
import { axialEquals, axialKey } from './hex';

const STARTING_MONEY = 10;
const MARKET_MIN_PRICE = 1;
const MARKET_DURATION_MS = 30_000;
const AUCTION_DURATION_MS = 30_000;
const BUY_DURATION_MS = 90_000;
const PATH_DURATION_MS = 90_000;
const ROOM_CLEANUP_DELAY_MS = 5 * 60_000;

function randomDice(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function randomDiceArray(n: number): number[] {
  return Array.from({ length: n }, () => randomDice());
}

function emptyPendingActions(): PendingActions {
  return { buy: {}, buyDone: {}, pathReady: {}, market: {}, marketSkip: {}, auctionBids: {}, conflicts: [] };
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => `${c}${c}`).join('')
    : normalized;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function colorDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function distinctPlayerColor(existing: string[]): string {
  let best = '#22c55e';
  let bestMinDistance = -1;
  for (let i = 0; i < 24; i += 1) {
    const candidate = randomColor({ luminosity: 'bright' }) as string;
    const minDistance = existing.length
      ? Math.min(...existing.map((c) => colorDistance(c, candidate)))
      : 999;
    if (minDistance > bestMinDistance) {
      best = candidate;
      bestMinDistance = minDistance;
    }
  }
  return best;
}

function ensurePlayerColors(players: Player[]): Player[] {
  const used: string[] = [];
  for (const p of players) {
    if (!p.color) p.color = distinctPlayerColor(used);
    used.push(p.color);
  }
  return players;
}

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async initialize(roundCount: number): Promise<void> {
    const config: GameConfig = {
      roundCount,
      phase: 'lobby',
      roundIndex: 0,
      marketMinPrice: MARKET_MIN_PRICE,
    };
    await this.ctx.storage.put('config', config);
    await this.ctx.storage.put('players', []);
    await this.ctx.storage.put('grid', []);
  }

  async getRoomMeta(): Promise<{ roundCount: number; playerCount: number; playerNames: string[] }> {
    const config = await this.ctx.storage.get<GameConfig>('config');
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    return {
      roundCount: config?.roundCount ?? 0,
      playerCount: players.length,
      playerNames: players.map((p) => p.displayName),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const pathMatch = /^\/room\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (pathMatch?.[1]) {
      await this.ctx.storage.put('roomId', pathMatch[1]);
    }
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const attachment = { playerId: null as string | null, playerName: '' };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    try {
      const data = JSON.parse(message) as { type: string; [k: string]: unknown };
      if (data.type === 'tick') {
        await this.maybeAdvanceTimedPhase();
        await this.broadcastState();
        return;
      }
      if (data.type === 'join') {
        await this.handleJoin(ws, data as { type: 'join'; playerName?: string });
      } else if (data.type === 'rejoin') {
        const payload = data as { type: 'rejoin'; playerId: string; playerName?: string };
        const players = await this.ctx.storage.get<Player[]>('players') ?? [];
        if (players.some((p) => p.playerId === payload.playerId)) {
          const attachment = ws.deserializeAttachment?.() as { playerId: string | null; playerName: string } | undefined;
          if (attachment) {
            attachment.playerId = payload.playerId;
            ws.serializeAttachment(attachment);
            await this.sendTo(ws, { type: 'joined', playerId: payload.playerId });
          }
        } else {
          const config = await this.ctx.storage.get<GameConfig>('config');
          if (config?.phase === 'lobby') {
            await this.handleJoin(ws, { type: 'join', playerName: payload.playerName });
            return;
          }
          await this.sendTo(ws, { type: 'error', message: 'Rejoin failed for this room.' });
        }
        await this.broadcastState();
      } else if (data.type === 'start_game') {
        await this.handleStartGame(ws);
      } else if (data.type === 'buy_cell') {
        await this.handleBuyCell(ws, data as { type: 'buy_cell'; cellId: string; role: 'producer' | 'seller' });
      } else if (data.type === 'buy_cell_cancel') {
        await this.handleBuyCellCancel(ws, data as { type: 'buy_cell_cancel'; cellId: string });
      } else if (data.type === 'buy_done') {
        await this.handleBuyDone(ws);
      } else if (data.type === 'auction_bid') {
        await this.handleAuctionBid(ws, data as { type: 'auction_bid'; conflictId: string; amount: number });
      } else if (data.type === 'path') {
        await this.handlePath(ws, data as { type: 'path'; producerId: string; sellerId: string; path: { q: number; r: number }[] });
      } else if (data.type === 'path_done') {
        await this.handlePathDone(ws);
      } else if (data.type === 'market_bid') {
        await this.handleMarketBid(ws, data as { type: 'market_bid'; dieIndex: number; amount: number });
      } else if (data.type === 'market_skip') {
        await this.handleMarketSkip(ws);
      } else if (data.type === 'market_recycle') {
        await this.handleMarketRecycle(ws, data as { type: 'market_recycle'; dieIndex: number });
      } else {
        await this.broadcastState();
      }
    } catch {
      // ignore
    }
  }

  private async maybeAdvanceTimedPhase(): Promise<void> {
    const config = await this.ctx.storage.get<GameConfig>('config');
    const timedPhases = new Set(['round_start', 'market_phase', 'buy_phase', 'auction', 'path_phase', 'round_end']);
    if (config && timedPhases.has(config.phase) && config.phaseEndsAt && Date.now() >= config.phaseEndsAt) {
      await this.alarm();
    }
  }

  private async handleJoin(ws: WebSocket, data: { type: 'join'; playerName?: string }): Promise<void> {
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'lobby') return;
    const players = ensurePlayerColors(await this.ctx.storage.get<Player[]>('players') ?? []);
    const playerId = crypto.randomUUID().slice(0, 8);
    const displayName = data.playerName ?? `Player ${players.length + 1}`;
    const newPlayer: Player = {
      playerId,
      displayName,
      color: distinctPlayerColor(players.map((p) => p.color)),
      money: 0,
      dice: [],
    };
    players.push(newPlayer);
    await this.ctx.storage.put('players', players);
    const attachment = ws.deserializeAttachment() as { playerId: string | null; playerName: string };
    attachment.playerId = playerId;
    attachment.playerName = displayName;
    ws.serializeAttachment(attachment);
    await this.sendTo(ws, { type: 'joined', playerId });
    await this.broadcastState();
  }

  private async handleStartGame(ws: WebSocket): Promise<void> {
    const config = await this.ctx.storage.get<GameConfig>('config');
    const players = ensurePlayerColors(await this.ctx.storage.get<Player[]>('players') ?? []);
    if (config?.phase !== 'lobby' || players.length < 2) {
      await this.sendTo(ws, { type: 'error', message: 'Need at least 2 players' });
      return;
    }
    const roundCount = config.roundCount;
    const minCells = players.length * roundCount;
    const blockedCount = Math.min(15, Math.max(5, Math.floor(minCells * 0.1)));
    const grid = generateGrid(minCells, blockedCount);
    const marketDiceCount = players.length - 1;
    const marketDice = randomDiceArray(marketDiceCount);

    for (let i = 0; i < players.length; i++) {
      players[i].money = STARTING_MONEY;
      players[i].dice = randomDiceArray(3);
    }

    const newConfig: GameConfig = {
      ...config,
      phase: 'round_start',
      roundIndex: 0,
      marketDice,
      marketMinPrice: MARKET_MIN_PRICE,
      phaseEndsAt: Date.now() + 2000,
    };
    await this.ctx.storage.put('config', newConfig);
    await this.ctx.storage.put('players', players);
    await this.ctx.storage.put('grid', grid);
    await this.ctx.storage.put('pendingActions', emptyPendingActions());
    await this.ctx.storage.put('submittedPaths', {});
    await this.ctx.setAlarm(Date.now() + 2000);
    await this.broadcastState();
  }

  async alarm(): Promise<void> {
    const config = await this.ctx.storage.get<GameConfig>('config');
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    const grid = await this.ctx.storage.get<Cell[]>('grid') ?? [];
    if (!config) return;

    if (config.phase === 'round_start') {
      this.applyOwnershipAging(grid);
      await this.ctx.storage.put('grid', grid);
      const submittedPaths = await this.ctx.storage.get<Record<string, { producerId: string; sellerId: string; path: { q: number; r: number }[]; revenue: number }>>('submittedPaths') ?? {};
      for (const p of players) p.money += 1;
      for (const [playerId, submitted] of Object.entries(submittedPaths)) {
        const player = players.find((p) => p.playerId === playerId);
        if (!player) continue;
        player.money += Math.max(0, Math.floor(submitted.revenue ?? 0));
      }
      await this.ctx.storage.put('players', players);
      const newConfig: GameConfig = {
        ...config,
        phase: 'market_phase',
        marketDice: randomDiceArray(players.length - 1),
        phaseEndsAt: Date.now() + MARKET_DURATION_MS,
      };
      await this.ctx.storage.put('config', newConfig);
      await this.ctx.setAlarm(Date.now() + MARKET_DURATION_MS);
      await this.broadcastState();
      return;
    }

    if (config.phase === 'market_phase') {
      const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
      const marketDice = [...(config.marketDice ?? [])];
      const minPrice = config.marketMinPrice ?? MARKET_MIN_PRICE;
      const bidsByDieIndex = new Map<number, Array<{ playerId: string; amount: number }>>();
      for (const [pid, act] of Object.entries(pending.market ?? {})) {
        if (act.amount < minPrice) continue;
        const list = bidsByDieIndex.get(act.dieIndex) ?? [];
        if (!list.some((entry) => entry.playerId === pid)) list.push({ playerId: pid, amount: act.amount });
        bidsByDieIndex.set(act.dieIndex, list);
      }
      const conflicts: PendingActions['conflicts'] = [];
      for (const [dieIndex, bids] of bidsByDieIndex) {
        if (dieIndex < 0 || dieIndex >= marketDice.length) continue;
        if (!bids.length) continue;
        let bestBid = -1;
        for (const bid of bids) {
          if (bid.amount > bestBid) bestBid = bid.amount;
        }
        const winners = bids.filter((bid) => bid.amount === bestBid).map((bid) => bid.playerId);
        if (winners.length === 1) {
          const player = players.find((p) => p.playerId === winners[0]);
          if (player && player.money >= bestBid) {
            player.money -= bestBid;
            player.dice.push(marketDice[dieIndex]);
            marketDice[dieIndex] = -1;
          }
        } else {
          conflicts.push({ conflictId: `market-${dieIndex}-${Date.now()}`, dieIndex, playerIds: winners, type: 'market' });
        }
      }
      await this.ctx.storage.put('players', players);
      if (conflicts.length > 0) {
        await this.ctx.storage.put('pendingActions', { ...pending, conflicts, auctionBids: {} });
        const newConfig: GameConfig = { ...config, phase: 'auction', marketDice, phaseEndsAt: Date.now() + AUCTION_DURATION_MS };
        await this.ctx.storage.put('config', newConfig);
        await this.ctx.setAlarm(Date.now() + AUCTION_DURATION_MS);
        await this.broadcastState();
        return;
      }
      const newMarketDice = marketDice.filter((v) => v !== -1);
      const newConfig: GameConfig = { ...config, phase: 'buy_phase', marketDice: newMarketDice, phaseEndsAt: Date.now() + BUY_DURATION_MS };
      await this.ctx.storage.put('config', newConfig);
      await this.ctx.storage.put('pendingActions', emptyPendingActions());
      await this.ctx.setAlarm(Date.now() + BUY_DURATION_MS);
      await this.broadcastState();
      return;
    }

    if (config.phase === 'buy_phase') {
      const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
      const roleByPlayerCell = new Map<string, 'producer' | 'seller'>();
      const byCell = new Map<string, string[]>();
      for (const [pid, acts] of Object.entries(pending.buy ?? {})) {
        const seen = new Set<string>();
        for (const act of acts ?? []) {
          if (!act?.cellId || seen.has(act.cellId)) continue;
          seen.add(act.cellId);
          roleByPlayerCell.set(`${pid}:${act.cellId}`, act.role);
          const list = byCell.get(act.cellId) ?? [];
          if (!list.includes(pid)) list.push(pid);
          byCell.set(act.cellId, list);
        }
      }
      const conflicts: PendingActions['conflicts'] = [];
      const toApply: Array<{ playerId: string; cellId: string; role: 'producer' | 'seller' }> = [];
      for (const [cellId, playerIds] of byCell) {
        if (playerIds.length === 1) {
          const cell = grid.find((c) => c.id === cellId);
          const player = players.find((p) => p.playerId === playerIds[0]);
          const role = roleByPlayerCell.get(`${playerIds[0]}:${cellId}`);
          if (cell && !cell.blocked && player && player.dice.includes(cell.diceValue) && role) {
            toApply.push({ playerId: playerIds[0], cellId, role });
          }
        } else {
          const conflictId = `conflict-${cellId}-${Date.now()}`;
          conflicts.push({ conflictId, cellId, playerIds, type: 'cell' });
        }
      }
      const playerDicePool = new Map<string, Map<number, number>>();
      for (const player of players) {
        const counts = new Map<number, number>();
        for (const die of player.dice) counts.set(die, (counts.get(die) ?? 0) + 1);
        playerDicePool.set(player.playerId, counts);
      }
      const filteredToApply: Array<{ playerId: string; cellId: string; role: 'producer' | 'seller' }> = [];
      for (const act of toApply) {
        const cell = grid.find((c) => c.id === act.cellId);
        if (!cell) continue;
        const pool = playerDicePool.get(act.playerId);
        const left = pool?.get(cell.diceValue) ?? 0;
        if (left <= 0) continue;
        pool!.set(cell.diceValue, left - 1);
        filteredToApply.push(act);
      }
      for (const { playerId, cellId, role } of filteredToApply) {
        const cell = grid.find((c) => c.id === cellId)!;
        const player = players.find((p) => p.playerId === playerId)!;
        if (!cell.owners) cell.owners = [];
        cell.owners.push({ playerId, role, roundsOwned: 0 });
        const dieIdx = player.dice.findIndex((d) => d === cell.diceValue);
        if (dieIdx >= 0) player.dice.splice(dieIdx, 1);
      }
      if (conflicts.length > 0) {
        await this.ctx.storage.put('pendingActions', { ...pending, conflicts, auctionBids: {} as Record<string, Record<string, number>> });
        const newConfig: GameConfig = { ...config, phase: 'auction', phaseEndsAt: Date.now() + AUCTION_DURATION_MS };
        await this.ctx.storage.put('config', newConfig);
        await this.ctx.storage.put('players', players);
        await this.ctx.storage.put('grid', grid);
        await this.ctx.setAlarm(Date.now() + AUCTION_DURATION_MS);
        await this.broadcastState();
        return;
      }
      await this.ctx.storage.put('players', players);
      await this.ctx.storage.put('grid', grid);
      const autoPathReady = this.computeAutoPathReady(players, grid);
      await this.ctx.storage.put('pendingActions', { ...emptyPendingActions(), pathReady: autoPathReady });
      const newConfig: GameConfig = { ...config, phase: 'path_phase', phaseEndsAt: Date.now() + PATH_DURATION_MS };
      await this.ctx.storage.put('config', newConfig);
      if (players.length > 0 && Object.keys(autoPathReady).length >= players.length) {
        await this.alarm();
      } else {
        await this.ctx.setAlarm(Date.now() + PATH_DURATION_MS);
      }
      await this.broadcastState();
      return;
    }

    if (config.phase === 'auction') {
      const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
      const marketDice = [...(config.marketDice ?? [])];
      for (const c of pending.conflicts) {
        const bids = pending.auctionBids[c.conflictId] ?? {};
        let bestBid = 0;
        for (const pid of c.playerIds) {
          const b = bids[pid] ?? 0;
          if (b > bestBid) bestBid = b;
        }
        if (c.type === 'market') {
          const bestPlayer = c.playerIds.find((pid) => (bids[pid] ?? 0) === bestBid) ?? c.playerIds[0];
          const player = players.find((p) => p.playerId === bestPlayer);
          if (c.dieIndex >= 0 && c.dieIndex < marketDice.length && marketDice[c.dieIndex] !== -1 && player && player.money >= bestBid) {
            const die = marketDice[c.dieIndex];
            marketDice[c.dieIndex] = -1;
            player.dice.push(die);
            player.money -= bestBid;
          }
        } else {
          const cell = grid.find((x) => x.id === c.cellId);
          if (!cell) continue;
          if (!cell.owners) cell.owners = [];
          const winners = c.playerIds.filter((pid) => (bids[pid] ?? 0) === bestBid);
          for (const pid of winners) {
            const player = players.find((p) => p.playerId === pid);
            const role = (pending.buy[pid] ?? []).find((a) => a.cellId === c.cellId)?.role;
            if (!player || player.money < bestBid || !role) continue;
            const dieIdx = player.dice.findIndex((d) => d === cell.diceValue);
            if (dieIdx < 0) continue;
            cell.owners.push({ playerId: pid, role, roundsOwned: 0 });
            player.money -= bestBid;
            player.dice.splice(dieIdx, 1);
          }
        }
      }
      await this.ctx.storage.put('players', players);
      await this.ctx.storage.put('grid', grid);
      const newMarketDiceAfterAuction = marketDice.filter((v) => v !== -1);
      const autoPathReady = this.computeAutoPathReady(players, grid);
      await this.ctx.storage.put('pendingActions', { ...emptyPendingActions(), pathReady: autoPathReady });
      const newConfig: GameConfig = { ...config, phase: 'path_phase', marketDice: newMarketDiceAfterAuction, phaseEndsAt: Date.now() + PATH_DURATION_MS };
      await this.ctx.storage.put('config', newConfig);
      if (players.length > 0 && Object.keys(autoPathReady).length >= players.length) {
        await this.alarm();
      } else {
        await this.ctx.setAlarm(Date.now() + PATH_DURATION_MS);
      }
      await this.broadcastState();
      return;
    }

    if (config.phase === 'path_phase') {
      for (const p of players) {
        if (p.dice.length === 0) p.dice = randomDiceArray(3);
      }
      await this.ctx.storage.put('players', players);
      const newConfig: GameConfig = { ...config, phase: 'round_end', phaseEndsAt: Date.now() + 5000 };
      await this.ctx.storage.put('config', newConfig);
      await this.ctx.setAlarm(Date.now() + 5000);
      await this.broadcastState();
      return;
    }

    if (config.phase === 'round_end') {
      const roundIndex = config.roundIndex + 1;
      if (roundIndex >= config.roundCount) {
        let best = players[0];
        const myCells = (pid: string) => grid.filter((c) => c.owners?.some((o) => o.playerId === pid)).length;
        for (const p of players) {
          if (p.money > best.money) best = p;
          else if (p.money === best.money && myCells(p.playerId) > myCells(best.playerId)) best = p;
        }
        const endAt = Date.now() + ROOM_CLEANUP_DELAY_MS;
        const newConfig: GameConfig = { ...config, phase: 'ended', roundIndex, phaseEndsAt: endAt };
        await this.ctx.storage.put('config', newConfig);
        await this.ctx.storage.put('winnerId', best.playerId);
        await this.broadcastState();
        await this.ctx.setAlarm(endAt);
        return;
      }
      await this.ctx.storage.put('pathUsed', {});
      const newConfig: GameConfig = {
        ...config,
        phase: 'round_start',
        roundIndex,
        marketDice: randomDiceArray(players.length - 1),
        phaseEndsAt: Date.now() + 2000,
      };
      await this.ctx.storage.put('config', newConfig);
      await this.ctx.setAlarm(Date.now() + 2000);
      await this.broadcastState();
      return;
    }

    if (config.phase === 'ended' && config.phaseEndsAt && Date.now() >= config.phaseEndsAt) {
      await this.cleanupRoom();
      return;
    }
  }

  private applyOwnershipAging(grid: Cell[]): void {
    for (const cell of grid) {
      if (!cell.owners || cell.owners.length === 0) continue;
      // Owned cells keep their owners forever, but productivity decays toward 1
      cell.producer = Math.max(1, cell.producer - 1);
      cell.seller  = Math.max(1, cell.seller - 1);
    }
  }

  private async cleanupRoom(): Promise<void> {
    const roomId = await this.ctx.storage.get<string>('roomId');
    try {
      await this.ctx.storage.delete('config');
      await this.ctx.storage.delete('players');
      await this.ctx.storage.delete('grid');
      await this.ctx.storage.delete('pendingActions');
      await this.ctx.storage.delete('submittedPaths');
      await this.ctx.storage.delete('winnerId');
      await this.ctx.storage.delete('pathUsed');
      if (roomId) {
        const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('default'));
        // @ts-ignore custom method on Lobby Durable Object
        await lobby.deleteRoom(roomId);
      }
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, 'Room ended');
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private async handleMarketBid(ws: WebSocket, data: { type: 'market_bid'; dieIndex: number; amount: number }): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) {
      await this.sendTo(ws, { type: 'error', message: 'Not joined to this room.' });
      await this.broadcastState();
      return;
    }
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'market_phase') {
      await this.broadcastState();
      return;
    }
    const marketDice = config.marketDice ?? [];
    if (data.dieIndex < 0 || data.dieIndex >= marketDice.length) return;
    if (data.amount < (config.marketMinPrice ?? MARKET_MIN_PRICE)) return;
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    pending.market = pending.market ?? {};
    pending.market[playerId] = { dieIndex: data.dieIndex, amount: data.amount };
    delete pending.marketSkip[playerId];
    await this.ctx.storage.put('pendingActions', pending);
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    const readyCount = Object.keys(pending.market).length + Object.keys(pending.marketSkip ?? {}).length;
    if (players.length > 0 && readyCount >= players.length) {
      await this.alarm();
      return;
    }
    await this.broadcastState();
  }

  private async handleMarketSkip(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) {
      await this.sendTo(ws, { type: 'error', message: 'Not joined to this room.' });
      await this.broadcastState();
      return;
    }
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'market_phase') {
      await this.broadcastState();
      return;
    }
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    delete pending.market[playerId];
    pending.marketSkip[playerId] = true;
    await this.ctx.storage.put('pendingActions', pending);
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    const readyCount = Object.keys(pending.market).length + Object.keys(pending.marketSkip ?? {}).length;
    if (players.length > 0 && readyCount >= players.length) {
      await this.alarm();
      return;
    }
    await this.broadcastState();
  }

  private async handleMarketRecycle(ws: WebSocket, data: { type: 'market_recycle'; dieIndex: number }): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) return;
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'market_phase') return;
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    const player = players.find((p) => p.playerId === playerId);
    if (!player) return;
    if (data.dieIndex < 0 || data.dieIndex >= player.dice.length) {
      await this.sendTo(ws, { type: 'error', message: 'Invalid die selected for recycle.' });
      return;
    }
    player.dice.splice(data.dieIndex, 1);
    player.money += 3;
    await this.ctx.storage.put('players', players);
    await this.broadcastState();
  }

  private async handleBuyCell(ws: WebSocket, data: { type: 'buy_cell'; cellId: string; role: 'producer' | 'seller' }): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) {
      await this.sendTo(ws, { type: 'error', message: 'Not joined to this room.' });
      await this.broadcastState();
      return;
    }
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'buy_phase') {
      await this.broadcastState();
      return;
    }
    const grid = await this.ctx.storage.get<Cell[]>('grid') ?? [];
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    const cell = grid.find((c) => c.id === data.cellId);
    const player = players.find((p) => p.playerId === playerId);
    if (!cell || cell.blocked || !player || !player.dice.includes(cell.diceValue)) {
      await this.sendTo(ws, { type: 'error', message: 'Invalid buy' });
      return;
    }
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    const current = pending.buy[playerId] ?? [];
    const withoutCell = current.filter((a) => a.cellId !== data.cellId);
    const candidate = [...withoutCell, { cellId: data.cellId, role: data.role }];
    const dicePool = new Map<number, number>();
    for (const die of player.dice) dicePool.set(die, (dicePool.get(die) ?? 0) + 1);
    const nextQueued: Array<{ cellId: string; role: 'producer' | 'seller' }> = [];
    const cellById = new Map(grid.map((c) => [c.id, c]));
    for (const action of candidate) {
      const target = cellById.get(action.cellId);
      if (!target || target.blocked) continue;
      const left = dicePool.get(target.diceValue) ?? 0;
      if (left <= 0) continue;
      dicePool.set(target.diceValue, left - 1);
      nextQueued.push(action);
    }
    if (!nextQueued.some((a) => a.cellId === data.cellId)) {
      await this.sendTo(ws, { type: 'error', message: `You can only queue as many ${cell.diceValue}s as dice you own.` });
      return;
    }
    pending.buy[playerId] = nextQueued;
    delete pending.buyDone[playerId];
    await this.ctx.storage.put('pendingActions', pending);
    await this.broadcastState();
  }

  private async handleBuyCellCancel(ws: WebSocket, data: { type: 'buy_cell_cancel'; cellId: string }): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) {
      await this.sendTo(ws, { type: 'error', message: 'Not joined to this room.' });
      await this.broadcastState();
      return;
    }
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'buy_phase') {
      await this.broadcastState();
      return;
    }
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    const current = pending.buy[playerId] ?? [];
    pending.buy[playerId] = current.filter((a) => a.cellId !== data.cellId);
    if (pending.buy[playerId].length === 0) delete pending.buy[playerId];
    delete pending.buyDone[playerId];
    await this.ctx.storage.put('pendingActions', pending);
    await this.broadcastState();
  }

  private async handleBuyDone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) {
      await this.sendTo(ws, { type: 'error', message: 'Not joined to this room.' });
      await this.broadcastState();
      return;
    }
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'buy_phase') {
      await this.broadcastState();
      return;
    }
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    pending.buyDone[playerId] = true;
    await this.ctx.storage.put('pendingActions', pending);
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    if (players.length > 0 && Object.keys(pending.buyDone ?? {}).length >= players.length) {
      await this.alarm();
      return;
    }
    await this.broadcastState();
  }

  private async handleAuctionBid(ws: WebSocket, data: { type: 'auction_bid'; conflictId: string; amount: number }): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) return;
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'auction') return;
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    const conflict = pending.conflicts.find((c) => c.conflictId === data.conflictId && c.playerIds.includes(playerId));
    if (!conflict) return;
    if (!pending.auctionBids[data.conflictId]) pending.auctionBids[data.conflictId] = {};
    pending.auctionBids[data.conflictId][playerId] = Math.max(0, data.amount);
    await this.ctx.storage.put('pendingActions', pending);
    await this.broadcastState();
  }

  private async handlePath(ws: WebSocket, data: { type: 'path'; producerId: string; sellerId: string; path: { q: number; r: number }[] }): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) return;
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'path_phase') return;
    const grid = await this.ctx.storage.get<Cell[]>('grid') ?? [];
    const producer = grid.find((c) => c.id === data.producerId);
    const seller = grid.find((c) => c.id === data.sellerId);
    if (!producer || !producer.owners?.some((o) => o.playerId === playerId && o.role === 'producer')) return;
    if (!seller || !seller.owners?.some((o) => o.playerId === playerId && o.role === 'seller')) return;
    const path = data.path;
    if (path.length < 2 || !axialEquals(path[0], { q: producer.q, r: producer.r }) || !axialEquals(path[path.length - 1], { q: seller.q, r: seller.r })) {
      await this.sendTo(ws, { type: 'error', message: 'Invalid path endpoints' });
      return;
    }
    const blockedSet = new Set(grid.filter((c) => c.blocked).map((c) => axialKey({ q: c.q, r: c.r })));
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const neighbors = [{ q: a.q + 1, r: a.r }, { q: a.q + 1, r: a.r - 1 }, { q: a.q, r: a.r - 1 }, { q: a.q - 1, r: a.r }, { q: a.q - 1, r: a.r + 1 }, { q: a.q, r: a.r + 1 }];
      if (!neighbors.some((n) => n.q === b.q && n.r === b.r)) {
        await this.sendTo(ws, { type: 'error', message: 'Path not contiguous' });
        return;
      }
      if (blockedSet.has(axialKey(b))) {
        await this.sendTo(ws, { type: 'error', message: 'Path crosses blocked cell' });
        return;
      }
    }
    const revenue = this.computePathRevenue(grid, playerId, producer, seller, path);
    const submittedPaths = (await this.ctx.storage.get<Record<string, { producerId: string; sellerId: string; path: { q: number; r: number }[]; revenue: number }>>('submittedPaths')) ?? {};
    submittedPaths[playerId] = { producerId: data.producerId, sellerId: data.sellerId, path: data.path, revenue };
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    pending.pathReady = pending.pathReady ?? {};
    delete pending.pathReady[playerId];
    await this.ctx.storage.put('pendingActions', pending);
    await this.ctx.storage.put('submittedPaths', submittedPaths);
    await this.sendTo(ws, { type: 'path_revenue', revenue, delta: 0 });
    await this.broadcastState();
  }

  private async handlePathDone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment?.() as { playerId: string | null } | undefined;
    const playerId = attachment?.playerId;
    if (!playerId) {
      await this.sendTo(ws, { type: 'error', message: 'Not joined to this room.' });
      await this.broadcastState();
      return;
    }
    const config = await this.ctx.storage.get<GameConfig>('config');
    if (config?.phase !== 'path_phase') {
      await this.broadcastState();
      return;
    }
    const pending = (await this.ctx.storage.get<PendingActions>('pendingActions')) ?? emptyPendingActions();
    pending.pathReady = pending.pathReady ?? {};
    pending.pathReady[playerId] = true;
    await this.ctx.storage.put('pendingActions', pending);
    const players = await this.ctx.storage.get<Player[]>('players') ?? [];
    if (players.length > 0 && Object.keys(pending.pathReady ?? {}).length >= players.length) {
      await this.alarm();
      return;
    }
    await this.broadcastState();
  }

  private computeAutoPathReady(players: Player[], grid: Cell[]): Record<string, true> {
    const ready: Record<string, true> = {};
    for (const player of players) {
      const hasProducer = grid.some((cell) => cell.owners?.some((o) => o.playerId === player.playerId && o.role === 'producer'));
      const hasSeller = grid.some((cell) => cell.owners?.some((o) => o.playerId === player.playerId && o.role === 'seller'));
      if (!hasProducer || !hasSeller) ready[player.playerId] = true;
    }
    return ready;
  }

  private computePathRevenue(grid: Cell[], playerId: string, producer: Cell, seller: Cell, path: { q: number; r: number }[]): number {
    const pathLength = path.length - 1;
    let enemyTerritory = 0;
    for (let i = 1; i < path.length - 1; i++) {
      const hex = path[i];
      const cell = grid.find((c) => c.q === hex.q && c.r === hex.r);
      if (cell?.owners?.some((o) => o.playerId !== playerId)) enemyTerritory++;
    }
    const effectiveSeller = Math.max(0, Math.min(seller.seller - pathLength - 2 * enemyTerritory, 1));
    return Math.floor(producer.producer * effectiveSeller);
  }

  private async sendTo(ws: WebSocket, msg: object): Promise<void> {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.broadcastState();
  }

  private async syncLobbyMeta(players: Player[]): Promise<void> {
    const roomId = await this.ctx.storage.get<string>('roomId');
    if (!roomId) return;
    try {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('default'));
      await lobby.setRoomPlayerCount(roomId, players.length, players.map((p) => p.displayName));
    } catch {
      // best effort only
    }
  }

  private async broadcastState(): Promise<void> {
    const config = await this.ctx.storage.get<GameConfig>('config');
    const rawPlayers = await this.ctx.storage.get<Player[]>('players') ?? [];
    const hadMissingColors = rawPlayers.some((p) => !p.color);
    const players = ensurePlayerColors(rawPlayers);
    if (hadMissingColors) await this.ctx.storage.put('players', players);
    await this.syncLobbyMeta(players);
    const grid = await this.ctx.storage.get<Cell[]>('grid');
    const winnerId = await this.ctx.storage.get<string>('winnerId');
    const pending = await this.ctx.storage.get<PendingActions>('pendingActions');
    const submittedPaths = await this.ctx.storage.get<Record<string, { producerId: string; sellerId: string; path: { q: number; r: number }[]; revenue: number }>>('submittedPaths') ?? {};
    const activeConflicts = config?.phase === 'auction' && pending?.conflicts?.length
      ? pending.conflicts.map((c) => ({ conflictId: c.conflictId, cellId: c.type === 'cell' ? c.cellId : undefined, dieIndex: c.type === 'market' ? c.dieIndex : undefined }))
      : undefined;
    const selectionStatus: Record<string, boolean> = {};
    for (const player of players ?? []) selectionStatus[player.playerId] = false;
    const phase = config?.phase;
    if (phase === 'buy_phase') {
      for (const playerId of Object.keys(pending?.buyDone ?? {})) selectionStatus[playerId] = true;
    } else if (phase === 'market_phase') {
      for (const playerId of Object.keys(pending?.market ?? {})) selectionStatus[playerId] = true;
      for (const playerId of Object.keys(pending?.marketSkip ?? {})) selectionStatus[playerId] = true;
    } else if (phase === 'auction') {
      const auctionBids = pending?.auctionBids ?? {};
      for (const byPlayer of Object.values(auctionBids)) {
        for (const playerId of Object.keys(byPlayer ?? {})) selectionStatus[playerId] = true;
      }
    } else if (phase === 'path_phase') {
      for (const playerId of Object.keys(pending?.pathReady ?? {})) selectionStatus[playerId] = true;
    }

    const baseState: GameState = {
      config: config ?? { roundCount: 3, phase: 'lobby', roundIndex: 0, marketMinPrice: 1 },
      grid: grid ?? [],
      players,
      winnerId: winnerId ?? undefined,
      activeConflicts,
      selectionStatus,
      pendingBuys: pending?.buy ?? {},
    };
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment?.() as { playerId?: string | null } | undefined;
        const myPlayerId = attachment?.playerId ?? null;
        const myMarketBid = myPlayerId ? (pending?.market?.[myPlayerId] ?? undefined) : undefined;
        const myAuctionBids: Record<string, number> = {};
        if (myPlayerId) {
          for (const [conflictId, byPlayer] of Object.entries(pending?.auctionBids ?? {})) {
            const amount = byPlayer?.[myPlayerId];
            if (typeof amount === 'number') myAuctionBids[conflictId] = amount;
          }
        }
        const mine = myPlayerId ? submittedPaths[myPlayerId] : undefined;
        const state: GameState = {
          ...baseState,
          myMarketBid,
          myAuctionBids,
          mySubmittedPath: mine ? { producerId: mine.producerId, sellerId: mine.sellerId, path: mine.path, revenue: mine.revenue } : undefined,
        };
        const msg = JSON.stringify({ type: 'state', state });
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }
}
