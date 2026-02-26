<script lang="ts">
  import { diceFace, diceFaces } from '$lib/dice';

  interface Props {
    marketDice: number[];
    minPrice: number;
    phase: string;
    myDice: number[];
    activeConflicts: Array<{ conflictId: string; cellId?: string; dieIndex?: number }>;
    myMarketBid?: { dieIndex: number; amount: number };
    myAuctionBids?: Record<string, number>;
    canSend?: boolean;
    onBid: (dieIndex: number, amount: number) => void;
    onSkip: () => void;
    onRecycle: (dieIndex: number) => void;
    onAuctionBid: (conflictId: string, amount: number) => void;
  }
  let { marketDice, minPrice, phase, myDice, activeConflicts, myMarketBid, myAuctionBids = {}, canSend = true, onBid, onSkip, onRecycle, onAuctionBid }: Props = $props();

  let bidAmount = $state(0);
  let bidDieIndex = $state(0);
  let auctionConflictId = $state('');
  let auctionAmount = $state(0);
  let minimized = $state(false);
  let x = $state(24);
  let y = $state(24);
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  $effect(() => {
    const list = activeConflicts ?? [];
    const first = list[0]?.conflictId ?? '';
    if (list.length > 0 && !list.some((c) => c.conflictId === auctionConflictId)) {
      auctionConflictId = first;
    } else if (!auctionConflictId) auctionConflictId = first;
  });

  const isMarket = $derived(phase === 'market_phase');
  const isAuction = $derived(phase === 'auction');
  const isActive = $derived(isMarket || isAuction);
  const canBid = $derived(isMarket && canSend && bidDieIndex >= 0 && bidDieIndex < marketDice.length && bidAmount >= minPrice);
  const canSkip = $derived(isMarket && canSend);
  const canSubmitAuction = $derived(isAuction && canSend && !!auctionConflictId && auctionAmount >= 0);

  $effect(() => {
    if (!isMarket) return;
    if (bidAmount < minPrice) bidAmount = minPrice;
    if (bidDieIndex >= marketDice.length) bidDieIndex = Math.max(0, marketDice.length - 1);
  });

  function onHeaderPointerDown(event: PointerEvent) {
    dragging = true;
    dragOffsetX = event.clientX - x;
    dragOffsetY = event.clientY - y;
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
  }

  function onWindowPointerMove(event: PointerEvent) {
    if (!dragging) return;
    x = Math.max(8, event.clientX - dragOffsetX);
    y = Math.max(8, event.clientY - dragOffsetY);
  }

  function onWindowPointerUp() {
    dragging = false;
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
  }

  $effect(() => {
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  });
</script>

{#if isActive}
  <div
    class="fixed z-50 w-96 rounded-lg border border-surface-500 bg-surface-900 shadow-xl overflow-hidden"
    style="left: {x}px; top: {y}px;"
  >
    <div
      role="toolbar"
      aria-label="Market dialog header"
      tabindex="0"
      class="flex items-center justify-between gap-2 px-3 py-2 bg-surface-800 border-b border-surface-500 cursor-move select-none"
      onpointerdown={onHeaderPointerDown}
    >
      <h2 class="text-sm font-semibold">{isAuction ? 'Auction' : 'Market'}</h2>
      <button class="btn preset-tonal-primary btn-sm" onclick={() => (minimized = !minimized)}>
        {minimized ? 'Expand' : 'Minimize'}
      </button>
    </div>

    {#if !minimized}
      <div class="p-4 space-y-3">
        {#if marketDice.length > 0}
          <p class="text-sm text-surface-400">
            Dice:
            <span class="text-2xl leading-none align-middle">{diceFaces(marketDice)}</span>
            (min price: {minPrice})
          </p>
          {#if isMarket}
            <div class="flex flex-wrap gap-2">
              {#each marketDice as die, idx (idx)}
                <button
                  class="btn btn-sm {bidDieIndex === idx ? 'preset-filled-primary-500' : 'preset-tonal-primary'}"
                  onclick={() => (bidDieIndex = idx)}
                  title={`Select market die #${idx}`}
                >
                  <span class="text-xs">#{idx}</span> <span class="text-2xl leading-none">{diceFace(die)}</span>
                </button>
              {/each}
            </div>
            <div class="flex gap-2 items-end">
              <label class="flex-1">
                <span class="text-xs text-surface-400">Bid (>= {minPrice})</span>
                <input type="number" min={minPrice} bind:value={bidAmount} class="input w-full size-sm" />
              </label>
              <button
                onclick={() => canBid && onBid(bidDieIndex, bidAmount)}
                class="btn preset-filled-primary-500 btn-sm"
                disabled={!canBid}
              >
                Bid
              </button>
              <button
                onclick={() => canSkip && onSkip()}
                class="btn preset-tonal-surface btn-sm"
                disabled={!canSkip}
              >
                Skip
              </button>
            </div>
            <div class="rounded border border-surface-600 bg-surface-800/50 p-2 space-y-2">
              <p class="text-xs text-surface-300">Recycle one of your dice for +3 money:</p>
              {#if (myDice?.length ?? 0) > 0}
                <div class="flex flex-wrap gap-2">
                  {#each myDice as die, idx (idx)}
                    <button
                      class="btn preset-tonal-success btn-sm"
                      onclick={() => canSend && onRecycle(idx)}
                      title={`Recycle your die #${idx}`}
                      disabled={!canSend}
                    >
                      <span class="text-xs">#{idx}</span> <span class="text-2xl leading-none">{diceFace(die)}</span>
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="text-xs text-surface-400">No dice available to recycle.</p>
              {/if}
            </div>
            {#if myMarketBid}
              <p class="text-xs text-primary-300">
                Your bid: #{myMarketBid.dieIndex} {diceFace(marketDice[myMarketBid.dieIndex] ?? 0)} for {myMarketBid.amount}
              </p>
            {/if}
          {/if}
          {#if isAuction && activeConflicts.length > 0}
            <div class="flex flex-col gap-2">
              <label>
                <span class="text-xs text-surface-400">Conflict</span>
                <select bind:value={auctionConflictId} class="input w-full size-sm">
                  {#each (activeConflicts ?? []) as c (c.conflictId)}
                    <option value={c.conflictId}>{c.conflictId}</option>
                  {/each}
                </select>
              </label>
              <div class="flex gap-2 items-end">
                <label class="flex-1">
                  <span class="text-xs text-surface-400">Your bid</span>
                  <input type="number" min="0" bind:value={auctionAmount} class="input w-full size-sm" />
                </label>
                <button
                  onclick={() => canSubmitAuction && onAuctionBid(auctionConflictId, auctionAmount)}
                  class="btn preset-filled-primary-500 btn-sm"
                  disabled={!canSubmitAuction}
                >
                  Submit
                </button>
              </div>
              {#if auctionConflictId && myAuctionBids[auctionConflictId] !== undefined}
                <p class="text-xs text-primary-300">Your bid for this conflict: {myAuctionBids[auctionConflictId]}</p>
              {/if}
            </div>
          {/if}
        {:else}
          <p class="text-surface-500 text-sm">No dice in market</p>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
