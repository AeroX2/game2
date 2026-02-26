<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { page } from '$app/state';
  import HexGrid from '$lib/components/HexGrid.svelte';
  import PlayerPanel from '$lib/components/PlayerPanel.svelte';
  import MarketPanel from '$lib/components/MarketPanel.svelte';
  import type { GameState } from '$lib/ws';
  import { goToLobby } from '$lib/nav';

  const roomId = $derived(page.params.roomId);

  let gameState = $state<GameState | null>(null);
  let ws = $state<WebSocket | null>(null);
  let myPlayerId = $state<string | null>(null);
  let error = $state('');
  let reconnectAttempt = $state(0);
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let now = $state(Date.now());
  let timeoutPokePhaseKey = $state('');
  let showRules = $state(false);
  let rulesMinimized = $state(false);
  let rulesX = $state(32);
  let rulesY = $state(90);
  let rulesDragging = false;
  let rulesDragOffsetX = 0;
  let rulesDragOffsetY = 0;
  const myPlayer = $derived((gameState?.players ?? []).find((p) => p.playerId === myPlayerId) ?? null);
  const myPendingBuys = $derived((myPlayerId ? (gameState?.pendingBuys?.[myPlayerId] ?? []) : []));
  const wsOpen = $derived(!!ws && ws.readyState === WebSocket.OPEN);
  const playerColors = $derived(
    Object.fromEntries((gameState?.players ?? []).map((p) => [p.playerId, p.color]))
  );
  const phaseEndsIn = $derived(gameState?.config.phaseEndsAt ? Math.max(0, Math.ceil((gameState.config.phaseEndsAt - now) / 1000)) : null);
  $effect(() => {
    if (phaseEndsIn === null) return;
    const t = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(t);
  });
  $effect(() => {
    if (!gameState?.config?.phase || phaseEndsIn === null) return;
    const phaseKey = `${gameState.config.phase}:${gameState.config.roundIndex}:${gameState.config.phaseEndsAt ?? 0}`;
    if (phaseEndsIn <= 0 && timeoutPokePhaseKey !== phaseKey) {
      timeoutPokePhaseKey = phaseKey;
      send({ type: 'tick' });
    }
  });
  $effect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const interval = setInterval(() => {
      send({ type: 'tick' });
    }, 2000);
    return () => clearInterval(interval);
  });

  // When a game reaches the ended phase, briefly show the winner then
  // automatically return everyone to the lobby so a new game can be started.
  $effect(() => {
    const phase = gameState?.config?.phase;
    if (phase !== 'ended') return;
    const timer = setTimeout(() => {
      try {
        ws?.close();
      } catch {}
      goToLobby();
    }, 5000);
    return () => clearTimeout(timer);
  });

  function wsBaseOrigin(): string {
    const base = env.PUBLIC_BACKEND_ORIGIN || location.origin;
    const url = new URL(base, location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.origin;
  }

  function connect(currentRoomId: string) {
    const url = `${wsBaseOrigin()}/room/${currentRoomId}`;
    const socket = new WebSocket(url);
    socket.onopen = () => {
      const name = sessionStorage.getItem('playerName') || 'Player';
      const savedPlayerId = sessionStorage.getItem(`game2:${currentRoomId}:playerId`);
      if (savedPlayerId) {
        socket.send(JSON.stringify({ type: 'rejoin', playerId: savedPlayerId, playerName: name }));
      } else {
        socket.send(JSON.stringify({ type: 'join', playerName: name }));
      }
      socket.send(JSON.stringify({ type: 'tick' }));
    };
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'joined' && msg.playerId) {
          myPlayerId = msg.playerId;
          sessionStorage.setItem(`game2:${currentRoomId}:playerId`, msg.playerId);
        } else if (msg.type === 'state' && msg.state) {
          gameState = msg.state;
        } else if (msg.type === 'error') {
          error = msg.message ?? 'Error';
        }
      } catch {}
    };
    socket.onclose = () => {
      ws = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectAttempt += 1;
      }, 1000);
    };
    socket.onerror = () => {
      error = 'Connection error';
    };

    return socket;
  }

  function send(msg: object): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function sendReliable(msg: object, retries = 2, delayMs = 140) {
    if (send(msg)) return;
    if (retries <= 0) {
      error = 'Still connecting. Action not sent.';
      return;
    }
    setTimeout(() => sendReliable(msg, retries - 1, delayMs), delayMs);
  }

  function sendPlayerAction(msg: object) {
    if (!myPlayerId) {
      error = 'Joining room… try again in a moment.';
      return;
    }
    sendReliable(msg);
  }

  $effect(() => {
    if (!roomId) return;
    reconnectAttempt;

    const socket = connect(roomId);
    ws = socket;

    return () => {
      socket.onclose = null;
      socket.close();
      if (ws === socket) ws = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
  });

  function startGame() {
    send({ type: 'start_game' });
    setTimeout(() => send({ type: 'tick' }), 150);
  }

  function leave() {
    ws?.close();
    goToLobby();
  }

  function onRulesHeaderPointerDown(event: PointerEvent) {
    rulesDragging = true;
    rulesDragOffsetX = event.clientX - rulesX;
    rulesDragOffsetY = event.clientY - rulesY;
    window.addEventListener('pointermove', onRulesWindowPointerMove);
    window.addEventListener('pointerup', onRulesWindowPointerUp);
  }

  function onRulesWindowPointerMove(event: PointerEvent) {
    if (!rulesDragging) return;
    rulesX = Math.max(8, event.clientX - rulesDragOffsetX);
    rulesY = Math.max(8, event.clientY - rulesDragOffsetY);
  }

  function onRulesWindowPointerUp() {
    rulesDragging = false;
    window.removeEventListener('pointermove', onRulesWindowPointerMove);
    window.removeEventListener('pointerup', onRulesWindowPointerUp);
  }

  $effect(() => {
    return () => {
      window.removeEventListener('pointermove', onRulesWindowPointerMove);
      window.removeEventListener('pointerup', onRulesWindowPointerUp);
    };
  });
</script>

<div class="p-4 flex flex-col gap-4 min-h-screen">
  <div class="flex justify-between items-center">
    <h1 class="text-xl font-bold">Room {roomId}</h1>
    <div class="flex items-center gap-2">
      <button onclick={() => (showRules = !showRules)} class="btn preset-tonal-primary btn-sm">
        {showRules ? 'Hide rules' : 'Rules'}
      </button>
      <button onclick={leave} class="btn preset-tonal-error btn-sm">Leave</button>
    </div>
  </div>

  {#if error}
    <p class="text-red-400">{error}</p>
  {/if}

  {#if gameState}
    {#if gameState.config?.phase === 'lobby'}
      <div class="rounded-lg border border-surface-500 bg-surface-900 p-4">
        <p class="mb-2">Players: {(gameState.players ?? []).length}. Need at least 2 to start.</p>
        {#if (gameState.players ?? []).length > 0}
          <div class="mb-3 space-y-1">
            {#each (gameState.players ?? []) as p (p.playerId)}
              <div class="text-sm text-surface-200">{p.displayName}</div>
            {/each}
          </div>
        {/if}
        <button onclick={startGame} disabled={(gameState.players ?? []).length < 2} class="btn preset-filled-primary-500">
          Start game
        </button>
      </div>
    {:else if gameState.config}
      {#if phaseEndsIn !== null}
        <p class="text-sm text-surface-400">Phase ends in {phaseEndsIn}s</p>
      {/if}
      <div class="flex gap-4 flex-wrap">
        <div class="flex-1 min-w-[300px]">
          <HexGrid
            grid={gameState.grid ?? []}
            phase={gameState.config.phase}
            myPlayerId={myPlayerId}
            myDice={myPlayer?.dice ?? []}
            playerColors={playerColors}
            myPendingBuys={myPendingBuys}
            mySubmittedPath={gameState.mySubmittedPath}
            onBuyCell={(cellId, role) => sendPlayerAction({ type: 'buy_cell', cellId, role })}
            onCancelBuy={(cellId) => sendPlayerAction({ type: 'buy_cell_cancel', cellId })}
            onSellCell={(cellId) => sendPlayerAction({ type: 'sell_cell', cellId })}
            onBuyDone={() => sendPlayerAction({ type: 'buy_done' })}
            onPath={(producerId, sellerId, path) => sendPlayerAction({ type: 'path', producerId, sellerId, path })}
            onPathDone={() => sendPlayerAction({ type: 'path_done' })}
          />
        </div>
        <div class="w-80 space-y-4">
          <PlayerPanel
            players={gameState.players ?? []}
            myPlayerId={myPlayerId}
            phase={gameState.config.phase}
            selectionStatus={gameState.selectionStatus ?? {}}
          />
          <MarketPanel
            marketDice={gameState.config.marketDice ?? []}
            minPrice={gameState.config.marketMinPrice ?? 1}
            phase={gameState.config.phase}
            myDice={myPlayer?.dice ?? []}
            activeConflicts={gameState.activeConflicts ?? []}
            myMarketBid={gameState.myMarketBid}
            myAuctionBids={gameState.myAuctionBids ?? {}}
            canSend={!!myPlayerId && wsOpen}
            onBid={(dieIndex, amount) => sendPlayerAction({ type: 'market_bid', dieIndex, amount })}
            onSkip={() => sendPlayerAction({ type: 'market_skip' })}
            onRecycle={(dieIndex) => sendPlayerAction({ type: 'market_recycle', dieIndex })}
            onAuctionBid={(conflictId, amount) => sendPlayerAction({ type: 'auction_bid', conflictId, amount })}
          />
        </div>
      </div>
      {#if gameState.config?.phase === 'ended' && gameState.winnerId}
        <p class="text-lg font-semibold">
          Winner: {(gameState.players ?? []).find((p) => p.playerId === gameState!.winnerId)?.displayName ?? gameState.winnerId}
        </p>
      {/if}
  {/if}
  {:else}
    <p class="text-surface-400">Connecting...</p>
  {/if}

  {#if showRules}
    <div
      class="fixed z-40 w-[28rem] rounded-lg border border-surface-500 bg-surface-900 shadow-xl overflow-hidden"
      style="left: {rulesX}px; top: {rulesY}px;"
    >
      <div
        role="toolbar"
        aria-label="Rules dialog header"
        tabindex="0"
        class="flex items-center justify-between gap-2 px-3 py-2 bg-surface-800 border-b border-surface-500 cursor-move select-none"
        onpointerdown={onRulesHeaderPointerDown}
      >
        <h2 class="text-sm font-semibold">Game Rules</h2>
        <div class="flex items-center gap-2">
          <button class="btn preset-tonal-primary btn-sm" onclick={() => (rulesMinimized = !rulesMinimized)}>
            {rulesMinimized ? 'Expand' : 'Minimize'}
          </button>
          <button class="btn preset-tonal-error btn-sm" onclick={() => (showRules = false)}>
            Dismiss
          </button>
        </div>
      </div>

      {#if !rulesMinimized}
        <div class="p-4 space-y-2 text-sm text-surface-200 max-h-[65vh] overflow-auto">
          <p><strong>Goal:</strong> End with the most money after all rounds.</p>
          <p><strong>Income:</strong> Each round, every player gains +1 money.</p>
          <p><strong>Cells:</strong> Buy with a matching die value. Choose producer or seller role. During the buy phase you may sell any cell you own for +1 money.</p>
          <p><strong>Grid:</strong> Blocked cells are unusable. Unowned cells are neutral.</p>
          <p><strong>Market:</strong> Bid on available dice (min price shown), or skip.</p>
          <p><strong>Auction:</strong> Conflicts are resolved with blind bids. Tied highest bids share cell ownership.</p>
          <p><strong>Paths:</strong> Drag a path from your producer cell to your seller cell during path phase.</p>
          <p><strong>Revenue:</strong> Based on producer value and seller value adjusted by path length and enemy territory.</p>
          <p><strong>Dice refresh:</strong> If you run out of dice, you receive 3 new random dice.</p>
          <p><strong>Winner:</strong> Highest money wins (tie-break uses owned cell count).</p>
        </div>
      {/if}
    </div>
  {/if}
</div>
