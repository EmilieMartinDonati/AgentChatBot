import type { chatApp } from "./graph";

/** Logs the nodes executed during the last turn, and the state after each one. */
export async function logLastTurn(graph: typeof chatApp, config: { configurable: { thread_id: string } }) {
  const snapshots = [];
  for await (const snapshot of graph.getStateHistory(config)) {
    snapshots.push(snapshot);
    if (snapshot.metadata?.source === "input") break; // start of this turn
  }
  snapshots.reverse(); // oldest first

  for (let i = 0; i < snapshots.length - 1; i++) {
    const node = snapshots[i].next[0];
    if (!node || node === "__start__") continue;

    // messages are long: only show how many there are
    const { messages, ...rest } = snapshots[i + 1].values as Record<string, unknown>;
    console.log(`▶ ${node}`, JSON.stringify({ messages: (messages as unknown[])?.length, ...rest }, null, 2));
  }

  const last = snapshots.at(-1);
  if (last?.next.length) console.log(`⏸ paused before: ${last.next.join(", ")}`);
}