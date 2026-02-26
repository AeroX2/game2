import type { DurableObjectNamespace, Fetcher } from '@cloudflare/workers-types';

export interface Env {
  ASSETS: Fetcher;
  LOBBY: DurableObjectNamespace;
  GAME_ROOM: DurableObjectNamespace;
}

export interface Axial {
  q: number;
  r: number;
}

export type GamePhase =
  | 'lobby'
  | 'round_start'
  | 'market_phase'
  | 'buy_phase'
  | 'path_phase'
  | 'auction'
  | 'round_end'
  | 'ended';

export interface CellOwner {
  playerId: string;
  role: 'producer' | 'seller';
  roundsOwned?: number;
}

export interface Cell {
  id: string;
  q: number;
  r: number;
  diceValue: number;
  producer: number;
  seller: number;
  blocked: boolean;
  owners?: CellOwner[];
}

export interface Player {
  playerId: string;
  displayName: string;
  color: string;
  money: number;
  dice: number[];
}

export interface GameConfig {
  roundCount: number;
  phase: GamePhase;
  roundIndex: number;
  marketDice?: number[];
  marketMinPrice?: number;
  phaseEndsAt?: number;
}

export interface GameState {
  config: GameConfig;
  grid: Cell[];
  players: Player[];
  winnerId?: string;
  activeConflicts?: Array<{ conflictId: string; cellId?: string; dieIndex?: number }>;
  selectionStatus?: Record<string, boolean>;
  pendingBuys?: Record<string, Array<{ cellId: string; role: 'producer' | 'seller' }>>;
  myMarketBid?: { dieIndex: number; amount: number };
  myAuctionBids?: Record<string, number>;
  mySubmittedPath?: { producerId: string; sellerId: string; path: Axial[]; revenue?: number };
}

export interface PendingActions {
  buy: Record<string, Array<{ cellId: string; role: 'producer' | 'seller' }>>;
  buyDone: Record<string, true>;
  pathReady: Record<string, true>;
  market: Record<string, { dieIndex: number; amount: number }>;
  marketSkip: Record<string, true>;
  auctionBids: Record<string, Record<string, number>>;
  conflicts: Array<
    | { conflictId: string; cellId: string; playerIds: string[]; type: 'cell' }
    | { conflictId: string; dieIndex: number; playerIds: string[]; type: 'market' }
  >;
}

export interface PathUsed {
  [playerId: string]: string[];
}
