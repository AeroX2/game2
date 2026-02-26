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
  mySubmittedPath?: { producerId: string; sellerId: string; path: { q: number; r: number }[]; revenue?: number };
}

export function connectGame(wsUrl: string, playerName: string): WebSocket {
  const proto = wsUrl.startsWith('https') ? 'wss' : 'ws';
  const url = wsUrl.replace(/^https?/, proto);
  const ws = new WebSocket(url);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', playerName }));
  };
  return ws;
}
