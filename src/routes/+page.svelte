<script lang="ts">
  import { goToGame } from '$lib/nav';
  import * as api from '$lib/api';

  let roundCount = $state(10);
  let rooms = $state<{ roomId: string; roundCount: number; playerCount: number; playerNames?: string[] }[]>([]);
  let loading = $state(false);
  let error = $state('');
  let joinRoomId = $state('');
  let playerName = $state('');
  let joinAsNew = $state(false);
  let roomJoinNames = $state<Record<string, string>>({});

  async function loadRooms() {
    try {
      loading = true;
      error = '';
      const data = await api.listRooms();
      rooms = data.rooms;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Load rooms immediately when the lobby page first mounts
    if (rooms.length === 0 && !loading) {
      loadRooms();
    }
  });

  async function createRoom() {
    try {
      loading = true;
      error = '';
      const { roomId } = await api.createRoom(roundCount);
      sessionStorage.setItem('playerName', playerName || 'Player');
      goToGame(roomId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function joinRoom(targetRoomId = joinRoomId, targetName = playerName) {
    const roomId = targetRoomId.trim();
    if (!roomId) return;
    try {
      loading = true;
      error = '';
      const name = targetName.trim() || 'Player';
      if (joinAsNew) {
        sessionStorage.removeItem(`game2:${roomId}:playerId`);
      }
      sessionStorage.setItem('playerName', name);
      await api.joinRoom(roomId, name);
      goToGame(roomId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
</script>

<div class="p-6 max-w-2xl mx-auto space-y-6">
  <h1 class="text-3xl font-bold">Hex Grid Game</h1>

  <div class="rounded-lg border border-surface-500 bg-surface-900 p-4 space-y-4">
    <h2 class="text-xl font-semibold">Create room</h2>
    <label class="block">
      <span class="text-sm text-surface-400">Rounds</span>
      <input type="number" min="2" max="10" bind:value={roundCount} class="input w-full mt-1" />
    </label>
    <label class="block">
      <span class="text-sm text-surface-400">Your name</span>
      <input type="text" bind:value={playerName} placeholder="Player" class="input w-full mt-1" />
    </label>
    <button onclick={createRoom} disabled={loading} class="btn variant-filled-primary">
      Create room
    </button>
  </div>

  <div class="rounded-lg border border-surface-500 bg-surface-900 p-4 space-y-4">
    <h2 class="text-xl font-semibold">Join room</h2>
    <label class="block">
      <span class="text-sm text-surface-400">Your name</span>
      <input type="text" bind:value={playerName} placeholder="Player" class="input w-full mt-1" />
    </label>
    <label class="block">
      <span class="text-sm text-surface-400">Room ID</span>
      <input type="text" bind:value={joinRoomId} placeholder="Room ID" class="input w-full mt-1" />
    </label>
    <label class="inline-flex items-center gap-2 text-sm text-surface-300">
      <input type="checkbox" bind:checked={joinAsNew} />
      Join as new player (ignore saved player ID)
    </label>
    <button onclick={() => joinRoom()} disabled={loading || !joinRoomId.trim()} class="btn variant-filled-primary">
      Join
    </button>
  </div>

  <div class="rounded-lg border border-surface-500 bg-surface-900 p-4 space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-xl font-semibold">Rooms</h2>
      <button onclick={loadRooms} disabled={loading} class="btn variant-soft-primary size-sm">Refresh</button>
    </div>
    {#if loading && rooms.length === 0}
      <p class="text-surface-400">Loading...</p>
    {:else if rooms.length === 0}
      <p class="text-surface-400">No rooms. Create one above.</p>
    {:else}
      <ul class="space-y-2">
        {#each rooms as room}
          <li class="flex flex-wrap gap-2 justify-between items-center p-2 rounded bg-surface-800">
            <span>
              {room.roomId} — {room.roundCount} rounds, {room.playerCount} players
              {#if (room.playerNames?.length ?? 0) > 0}
                — {room.playerNames!.join(', ')}
              {/if}
            </span>
            <div class="flex gap-2 items-center">
              <input
                type="text"
                class="input size-sm w-36"
                placeholder="Your name"
                value={roomJoinNames[room.roomId] ?? playerName}
                oninput={(e) => {
                  roomJoinNames[room.roomId] = (e.currentTarget as HTMLInputElement).value;
                }}
              />
              <button
                onclick={() => {
                  joinRoom(room.roomId, roomJoinNames[room.roomId] ?? playerName);
                }}
                disabled={loading}
                class="btn variant-soft-primary size-sm"
              >
                Join
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if error}
    <p class="text-red-400">{error}</p>
  {/if}
</div>
