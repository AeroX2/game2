<script lang="ts">
  import { diceFace } from '$lib/dice';
  import { axialDistance } from '$lib/hex';
  import { defineHex, fromCoordinates, Grid, Orientation } from 'honeycomb-grid';
  import { animate } from 'animejs';
  import type { Cell } from '$lib/ws';

  interface Props {
    grid: Cell[];
    phase: string;
    myPlayerId: string | null;
    myDice: number[];
    playerColors: Record<string, string>;
    myPendingBuys: Array<{ cellId: string; role: 'producer' | 'seller' }>;
    mySubmittedPath?: { producerId: string; sellerId: string; path: { q: number; r: number }[]; revenue?: number };
    onBuyCell: (cellId: string, role: 'producer' | 'seller') => void;
    onCancelBuy: (cellId: string) => void;
    onBuyDone: () => void;
    onPath: (producerId: string, sellerId: string, path: { q: number; r: number }[]) => void;
    onPathDone: () => void;
  }
  let { grid, phase, myPlayerId, myDice, playerColors, myPendingBuys, mySubmittedPath, onBuyCell, onCancelBuy, onBuyDone, onPath, onPathDone }: Props = $props();

  const HEX_RADIUS = 24;
  const Hex = defineHex({ dimensions: HEX_RADIUS, orientation: Orientation.FLAT });
  const VIEWBOX_PADDING = 28;
  const canBuy = $derived(phase === 'buy_phase' && myPlayerId);
  let selectedCellId: string | null = $state(null);
  let pathStart: string | null = $state(null);
  let pathEnd: string | null = $state(null);
  let dragPathIds: string[] = $state([]);
  let isDraggingPath = $state(false);
  let clickHint = $state('');
  let svgEl: SVGSVGElement | null = null;
  let dragLineEl = $state<SVGPolylineElement | null>(null);
  let committedLineEl = $state<SVGPolylineElement | null>(null);
  let roundIncomeEl = $state<SVGGElement | null>(null);
  let roundIncomePop = $state<{ x: number; y: number; amount: number; key: number } | null>(null);
  let previousPhase = '';

  $effect(() => {
    phase;
    selectedCellId = null;
    pathStart = null;
    pathEnd = null;
    dragPathIds = [];
    isDraggingPath = false;
    clickHint = '';
  });

  function ownerColor(cell: Cell): string | null {
    if (!cell.owners?.length) return null;
    const mine = myPlayerId ? cell.owners.find((o) => o.playerId === myPlayerId) : undefined;
    const preferred = mine?.playerId ?? cell.owners[0].playerId;
    return playerColors[preferred] ?? null;
  }

  function darkenColor(hex: string, factor = 0.5): string {
    const raw = hex.replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => `${c}${c}`).join('') : raw;
    if (full.length !== 6) return hex;
    const r = Math.max(0, Math.min(255, Math.floor(parseInt(full.slice(0, 2), 16) * factor)));
    const g = Math.max(0, Math.min(255, Math.floor(parseInt(full.slice(2, 4), 16) * factor)));
    const b = Math.max(0, Math.min(255, Math.floor(parseInt(full.slice(4, 6), 16) * factor)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  function isOwnedByOther(cell: Cell): boolean {
    if (!myPlayerId) return false;
    return !!cell.owners?.length && !cell.owners.some((o) => o.playerId === myPlayerId);
  }

  function cellFill(cell: Cell): string {
    if (cell.blocked) return '#2b2f36';
    if (isPathCellDimmed(cell)) return '#405b49';
    const base = ownerColor(cell) ?? '#b4bbc6';
    if (phase === 'path_phase' && isOwnedByOther(cell)) return darkenColor(base, 0.42);
    return base;
  }

  function cellStroke(cell: Cell): string {
    if (selectedCellId === cell.id) return '#f59e0b';
    if (pendingBuyByCell.has(cell.id)) return '#38bdf8';
    if (pathStart === cell.id) return '#22c55e';
    if (pathEnd === cell.id) return '#a855f7';
    if (dragPathIds.includes(cell.id)) return '#84cc16';
    return '#111827';
  }

  function cellStrokeWidth(cell: Cell): number {
    if (selectedCellId === cell.id || pathStart === cell.id || pathEnd === cell.id || dragPathIds.includes(cell.id)) return 3;
    return 1;
  }

  function handleCellClick(cell: Cell) {
    clickHint = '';
    if (cell.blocked) {
      clickHint = 'This cell is blocked and cannot be used.';
      return;
    }
    if (canBuy && !cell.blocked) {
      if (pendingBuyByCell.has(cell.id)) {
        clickHint = `Already queued as ${pendingBuyByCell.get(cell.id)}. Cancel it below to change.`;
        return;
      }
      if (!myDice.includes(cell.diceValue)) {
        clickHint = `You need ${diceFace(cell.diceValue)} to buy this cell.`;
        return;
      }
      selectedCellId = cell.id;
      pathStart = null;
      pathEnd = null;
      clickHint = `Selected cell. Choose Producer or Seller to confirm.`;
      return;
    }
    if (phase === 'path_phase') {
      clickHint = pathStart
        ? 'Finish on one of your seller cells.'
        : 'Start dragging from one of your producer cells.';
      return;
    }
    if (phase === 'buy_phase') {
      clickHint = 'Click a cell with a dice face matching one of your dice.';
      return;
    }
    clickHint = `Cells are interactive during buy/path phases. Current phase: ${phase}.`;
  }

  function confirmBuy(role: 'producer' | 'seller') {
    if (selectedCellId) {
      onBuyCell(selectedCellId, role);
      clickHint = `Queued purchase as ${role}. You can cancel it before pressing done.`;
      selectedCellId = null;
    }
  }

  const safeGrid = $derived(
    (Array.isArray(grid) ? grid : [])
      .filter((c): c is Cell => c != null && typeof c.id === 'string')
  );
  const hexModels = $derived.by(() =>
    safeGrid.map((cell) => {
      const hex = new Hex({ q: cell.q, r: cell.r });
      return { cell, hex };
    })
  );
  const cellById = $derived.by(() => new Map(safeGrid.map((c) => [c.id, c])));
  const pendingBuyByCell = $derived.by(() => new Map((myPendingBuys ?? []).map((b) => [b.cellId, b.role])));
  const cellByAxialKey = $derived.by(() => new Map(safeGrid.map((c) => [`${c.q},${c.r}`, c])));
  const honeycombGrid = $derived.by(
    () => new Grid(Hex, fromCoordinates(...safeGrid.map((c) => [c.q, c.r] as [number, number])))
  );

  const viewBoxData = $derived.by(() => {
    if (hexModels.length === 0) return { minX: -50, minY: -50, width: 400, height: 400 };
    const xs = hexModels.map(({ hex }) => hex.x);
    const ys = hexModels.map(({ hex }) => hex.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(260, maxX - minX + HEX_RADIUS * 2 + VIEWBOX_PADDING * 2);
    const height = Math.max(260, maxY - minY + HEX_RADIUS * 2 + VIEWBOX_PADDING * 2);
    return {
      minX: minX - HEX_RADIUS - VIEWBOX_PADDING,
      minY: minY - HEX_RADIUS - VIEWBOX_PADDING,
      width,
      height
    };
  });
  const viewBox = $derived(`${viewBoxData.minX} ${viewBoxData.minY} ${viewBoxData.width} ${viewBoxData.height}`);

  function isOwnedByMe(cell: Cell): boolean {
    return !!cell.owners?.some((o) => o.playerId === myPlayerId);
  }

  function hasMyRole(cell: Cell, role: 'producer' | 'seller'): boolean {
    return !!cell.owners?.some((o) => o.playerId === myPlayerId && o.role === role);
  }

  function isPathCellDimmed(cell: Cell): boolean {
    if (phase !== 'path_phase') return false;
    if (!myPlayerId) return false;
    if (mySubmittedPath && (cell.id === mySubmittedPath.producerId || cell.id === mySubmittedPath.sellerId)) {
      return true;
    }
    if (!pathStart) {
      return hasMyRole(cell, 'seller');
    }
    return hasMyRole(cell, 'producer') && cell.id !== pathStart;
  }

  function cellFromPointer(event: PointerEvent): Cell | null {
    if (!svgEl) return null;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = viewBoxData.minX + ((event.clientX - rect.left) / rect.width) * viewBoxData.width;
    const y = viewBoxData.minY + ((event.clientY - rect.top) / rect.height) * viewBoxData.height;
    const hovered = honeycombGrid.pointToHex({ x, y }, { allowOutside: false });
    if (!hovered) return null;
    return cellByAxialKey.get(`${hovered.q},${hovered.r}`) ?? null;
  }

  function startPathDrag(cell: Cell, event: PointerEvent) {
    if (phase !== 'path_phase') return;
    if (!hasMyRole(cell, 'producer')) {
      clickHint = 'Path must start from one of your producer cells.';
      return;
    }
    isDraggingPath = true;
    dragPathIds = [cell.id];
    pathStart = cell.id;
    pathEnd = null;
    clickHint = 'Drag across cells, then release on another owned cell.';
    svgEl?.setPointerCapture(event.pointerId);
  }

  function handlePathPointerMove(event: PointerEvent) {
    if (!isDraggingPath) return;
    const cell = cellFromPointer(event);
    if (!cell || cell.blocked) return;
    const lastId = dragPathIds[dragPathIds.length - 1];
    if (!lastId || cell.id === lastId) return;

    if (dragPathIds.length >= 2 && cell.id === dragPathIds[dragPathIds.length - 2]) {
      dragPathIds = dragPathIds.slice(0, -1);
      return;
    }
    if (dragPathIds.includes(cell.id)) return;

    const lastCell = cellById.get(lastId);
    if (!lastCell || axialDistance(lastCell, cell) !== 1) return;

    dragPathIds = [...dragPathIds, cell.id];
    pathEnd = cell.id;
  }

  function finishPathDrag(event: PointerEvent) {
    if (!isDraggingPath) return;
    isDraggingPath = false;
    if (svgEl?.hasPointerCapture(event.pointerId)) svgEl.releasePointerCapture(event.pointerId);

    if (dragPathIds.length < 2) {
      clickHint = 'Path too short. Drag to another cell.';
      dragPathIds = [];
      pathStart = null;
      pathEnd = null;
      return;
    }

    const start = cellById.get(dragPathIds[0]);
    const end = cellById.get(dragPathIds[dragPathIds.length - 1]);
    if (!start || !end || !hasMyRole(start, 'producer') || !hasMyRole(end, 'seller')) {
      clickHint = 'Path must start on your producer and end on your seller.';
      dragPathIds = [];
      pathStart = null;
      pathEnd = null;
      return;
    }

    onPath(
      start.id,
      end.id,
      dragPathIds
        .map((id) => cellById.get(id))
        .filter((c): c is Cell => !!c)
        .map((c) => ({ q: c.q, r: c.r }))
    );
    clickHint = 'Path submitted.';
    dragPathIds = [];
    pathStart = null;
    pathEnd = null;
  }

  const dragPreview = $derived.by(() =>
    dragPathIds
      .map((id) => {
        const model = hexModels.find((h) => h.cell.id === id);
        return model ? `${model.hex.x},${model.hex.y}` : null;
      })
      .filter((p): p is string => !!p)
      .join(' ')
  );

  const committedPathPreview = $derived.by(() => {
    if (!mySubmittedPath?.path?.length) return '';
    return mySubmittedPath.path
      .map((ax) => {
        const model = hexModels.find((h) => h.cell.q === ax.q && h.cell.r === ax.r);
        return model ? `${model.hex.x},${model.hex.y}` : null;
      })
      .filter((p): p is string => !!p)
      .join(' ');
  });

  $effect(() => {
    const currentPhase = phase;
    const submitted = mySubmittedPath;
    if (currentPhase === 'round_start' && previousPhase !== 'round_start' && submitted?.path?.length && (submitted.revenue ?? 0) > 0) {
      const points = submitted.path
        .map((ax) => {
          const model = hexModels.find((h) => h.cell.q === ax.q && h.cell.r === ax.r);
          return model ? { x: model.hex.x, y: model.hex.y } : null;
        })
        .filter((p): p is { x: number; y: number } => !!p);
      if (points.length > 0) {
        const midpoint = points[Math.floor(points.length / 2)];
        roundIncomePop = { x: midpoint.x, y: midpoint.y - 22, amount: submitted.revenue ?? 0, key: Date.now() };
      }
    }
    previousPhase = currentPhase;
  });

  $effect(() => {
    if (!roundIncomePop || !roundIncomeEl) return;
    const node = roundIncomeEl;
    const animation = animate(node, {
      translateY: [0, -30],
      scale: [0.8, 1.08, 1],
      opacity: [0, 1, 1, 0],
      duration: 2600,
      ease: 'outExpo'
    });
    return () => animation.pause();
  });

  $effect(() => {
    if (!roundIncomePop) return;
    const timer = setTimeout(() => {
      roundIncomePop = null;
    }, 2700);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!dragLineEl) return;
    const line = dragLineEl;
    line.style.strokeDasharray = '10 8';
    const animation = animate(line, {
      strokeDashoffset: [0, -36],
      duration: 1400,
      loop: true,
      ease: 'linear'
    });
    return () => animation.pause();
  });

  $effect(() => {
    if (!committedLineEl) return;
    const line = committedLineEl;
    line.style.strokeDasharray = '9 7';
    const animation = animate(line, {
      strokeDashoffset: [0, -32],
      duration: 1700,
      loop: true,
      ease: 'linear'
    });
    return () => animation.pause();
  });

  function cellTagline(cell: Cell): string {
    if (!cell.owners?.length) return `P${cell.producer}/S${cell.seller}`;
    const roles = new Set(cell.owners.map((o) => o.role));
    const tags: string[] = [];
    if (roles.has('producer')) tags.push(`P${cell.producer}`);
    if (roles.has('seller')) tags.push(`S${cell.seller}`);
    return tags.join(' ');
  }
</script>

<div class="overflow-auto p-4">
  <svg
    bind:this={svgEl}
    viewBox={viewBox}
    role="application"
    aria-label="Hex game grid"
    class="w-full max-w-2xl"
    style="min-height: 400px;"
    onpointermove={handlePathPointerMove}
    onpointerup={finishPathDrag}
    onpointercancel={finishPathDrag}
  >
    <defs>
      <marker id="drag-arrow-head" markerWidth="5" markerHeight="5" refX="4.5" refY="2.5" orient="auto">
        <path d="M0,0 L5,2.5 L0,5 Z" fill="#84cc16" />
      </marker>
    </defs>
    {#each hexModels as { cell, hex } (cell.id)}
      <g
        role="button"
        tabindex="0"
        transform="translate({hex.x}, {hex.y})"
        class="cursor-pointer focus:outline-none"
        style="outline: none;"
        onmousedown={(e) => e.preventDefault()}
        onpointerdown={(e) => startPathDrag(cell, e)}
        onclick={() => handleCellClick(cell)}
        onkeydown={(e) => e.key === 'Enter' && handleCellClick(cell)}
      >
        <polygon
          points={hex.corners.map((p) => `${p.x - hex.x},${p.y - hex.y}`).join(' ')}
          fill={cellFill(cell)}
          stroke={cellStroke(cell)}
          stroke-width={cellStrokeWidth(cell)}
        />
        {#if !cell.blocked}
          <text x="0" y="4" text-anchor="middle" class="fill-white text-2xl leading-none">
            {diceFace(cell.diceValue)}
          </text>
          <text x="0" y="13" text-anchor="middle" class="fill-surface-300 text-[10px]">
            {cellTagline(cell)}
          </text>
        {/if}
      </g>
    {/each}
    {#if committedPathPreview}
      <polyline
        bind:this={committedLineEl}
        points={committedPathPreview}
        fill="none"
        stroke="#60a5fa"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="pointer-events: none;"
      />
    {/if}
    {#if dragPathIds.length > 1 && dragPreview}
      <polyline
        bind:this={dragLineEl}
        points={dragPreview}
        fill="none"
        stroke="#84cc16"
        stroke-width="4"
        stroke-linecap="round"
        stroke-linejoin="round"
        marker-end="url(#drag-arrow-head)"
        style="pointer-events: none;"
      />
    {/if}
    {#if roundIncomePop}
      <g
        bind:this={roundIncomeEl}
        transform="translate({roundIncomePop.x}, {roundIncomePop.y})"
        style="pointer-events: none;"
      >
        <text
          x="0"
          y="0"
          text-anchor="middle"
          class="fill-success-300 text-sm font-semibold"
          stroke="#0f172a"
          stroke-width="0.5"
          paint-order="stroke fill"
        >
          +{roundIncomePop.amount}
        </text>
      </g>
    {/if}
  </svg>
  {#if canBuy && selectedCellId}
    <p class="text-sm text-surface-400 mt-2">
      Selected cell. Buy as:
      <button onclick={() => confirmBuy('producer')} class="btn preset-tonal-primary btn-sm mx-1">Producer</button>
      <button onclick={() => confirmBuy('seller')} class="btn preset-tonal-primary btn-sm mx-1">Seller</button>
      <button onclick={() => selectedCellId = null} class="btn preset-tonal-error btn-sm mx-1">Cancel</button>
    </p>
  {/if}
  {#if canBuy}
    <div class="mt-2 rounded border border-surface-600 bg-surface-900/60 p-2 space-y-2 text-sm">
      <p class="text-surface-300">
        Attempting purchases: {myPendingBuys.length}
      </p>
      {#if myPendingBuys.length > 0}
        <div class="space-y-1">
          {#each myPendingBuys as buy (buy.cellId)}
            <div class="flex items-center justify-between gap-2">
              <span class="text-surface-200">{buy.cellId} ({buy.role})</span>
              <button class="btn preset-tonal-error btn-sm" onclick={() => onCancelBuy(buy.cellId)}>Cancel</button>
            </div>
          {/each}
        </div>
      {/if}
      <button class="btn preset-filled-primary-500 btn-sm" onclick={onBuyDone}>Done buying</button>
    </div>
  {/if}
  {#if phase === 'path_phase' && pathStart}
    <p class="text-sm text-surface-400 mt-2">
      Drag path in progress from selected start cell.
    </p>
  {/if}
  {#if clickHint}
    <p class="text-sm text-surface-300 mt-2">{clickHint}</p>
  {/if}
  {#if phase === 'path_phase' && mySubmittedPath}
    <p class="text-sm text-primary-300 mt-2">
      Path submitted: {mySubmittedPath.producerId} → {mySubmittedPath.sellerId}
    </p>
  {/if}
  {#if phase === 'path_phase'}
    <div class="mt-2">
      <button class="btn preset-filled-primary-500 btn-sm" onclick={onPathDone}>Ready</button>
    </div>
  {/if}
</div>
