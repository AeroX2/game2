<script lang="ts">
  import { animate } from 'animejs';
  import { diceFace, diceFaces } from '$lib/dice';
  import type { Player } from '$lib/ws';

  interface Props {
    players: Player[];
    myPlayerId: string | null;
    phase: string;
    selectionStatus?: Record<string, boolean>;
  }
  let { players, myPlayerId, phase, selectionStatus = {} }: Props = $props();

  const me = $derived(players.find((p) => p.playerId === myPlayerId));
  let myMoneyEl: HTMLDivElement | null = null;
  let myDiceEl: HTMLDivElement | null = null;
  let previousMyMoney: number | null = null;
  let previousMyDice: number[] = [];

  function spawnFloatingMoney(delta: number) {
    if (!myMoneyEl) return;
    const node = document.createElement('div');
    node.className = 'pointer-events-none absolute right-1 top-0 font-semibold text-success-300';
    node.textContent = `+$${delta}`;
    myMoneyEl.appendChild(node);
    const animation = animate(node, {
      translateY: [0, -22],
      opacity: [1, 0],
      duration: 1500,
      ease: 'outExpo'
    });
    animation.then(() => node.remove());
  }

  function spawnDiceUseParticles() {
    if (!myDiceEl) return;
    for (let i = 0; i < 7; i += 1) {
      const dot = document.createElement('span');
      const dx = Math.random() * 40 - 20;
      const dy = -(Math.random() * 24 + 10);
      dot.className = 'pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full bg-warning-300';
      myDiceEl.appendChild(dot);
      const animation = animate(dot, {
        translateX: [0, dx],
        translateY: [0, dy],
        scale: [1, 0.2],
        opacity: [1, 0],
        duration: 1000,
        ease: 'outExpo'
      });
      animation.then(() => dot.remove());
    }
  }

  function collectAddedDice(next: number[], prev: number[]): number[] {
    const counter = new Map<number, number>();
    for (const value of prev) counter.set(value, (counter.get(value) ?? 0) + 1);
    const added: number[] = [];
    for (const value of next) {
      const remaining = counter.get(value) ?? 0;
      if (remaining > 0) counter.set(value, remaining - 1);
      else added.push(value);
    }
    return added;
  }

  function spawnDiceGainOverlay(added: number[]) {
    if (!myDiceEl || added.length === 0) return;
    const overlay = document.createElement('div');
    overlay.className =
      'pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-4xl leading-none';
    overlay.textContent = added.map((value) => diceFace(value)).join('');
    myDiceEl.appendChild(overlay);
    const animation = animate(overlay, {
      translateY: [-38, 0],
      scale: [1.9, 0.85],
      opacity: [1, 0],
      duration: 1500,
      ease: 'outExpo'
    });
    animation.then(() => overlay.remove());
  }

  $effect(() => {
    if (!me) {
      previousMyMoney = null;
      return;
    }
    if (previousMyMoney !== null && me.money > previousMyMoney) {
      spawnFloatingMoney(me.money - previousMyMoney);
    }
    previousMyMoney = me.money;
  });

  $effect(() => {
    const current = me?.dice ?? [];
    if (!me) {
      previousMyDice = [];
      return;
    }
    if (previousMyDice.length > 0) {
      if (current.length < previousMyDice.length) spawnDiceUseParticles();
      if (current.length > previousMyDice.length) {
        spawnDiceGainOverlay(collectAddedDice(current, previousMyDice));
      }
    }
    previousMyDice = [...current];
  });

  $effect(() => {
    players;
    myPlayerId;
    if (!myPlayerId) {
      myMoneyEl = null;
      myDiceEl = null;
      return;
    }
    myMoneyEl = document.getElementById(`player-money-${myPlayerId}`) as HTMLDivElement | null;
    myDiceEl = document.getElementById(`player-dice-${myPlayerId}`) as HTMLDivElement | null;
  });
</script>

<div class="rounded-lg border border-surface-500 bg-surface-900 p-4 space-y-3">
  <h2 class="text-lg font-semibold">Players</h2>
  {#each (players ?? []) as player (player.playerId)}
    <div
      class="p-2 rounded border relative overflow-visible"
      style="
        border-color: {player.color};
        background: {player.playerId === myPlayerId ? `${player.color}33` : `${player.color}1f`};
      "
    >
      <div class="font-medium">{player.displayName} {player.playerId === myPlayerId ? '(you)' : ''}</div>
      <div class="text-sm text-surface-400 relative" id={`player-money-${player.playerId}`}>
        Money: {player.money}
      </div>
      <div
        class="text-2xl leading-tight relative min-h-9 flex items-center"
        id={`player-dice-${player.playerId}`}
      >
        Dice: {diceFaces(player.dice)}
      </div>
      {#if phase === 'buy_phase' || phase === 'market_phase' || phase === 'auction' || phase === 'path_phase'}
        <div class="text-xs mt-1 {selectionStatus[player.playerId] ? 'text-success-400' : 'text-surface-400'}">
          {selectionStatus[player.playerId] ? 'Ready' : 'Waiting'}
        </div>
      {/if}
    </div>
  {/each}
  <p class="text-sm text-surface-500">Phase: {phase}</p>
</div>
