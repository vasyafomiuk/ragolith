// Pure multi-hop call-graph traversal (BFS over call edges).
//
// Call edges store `caller` as a (possibly qualified) `Name` / `Class.method`
// and `callee` as a bare name. To chain hops we compare on the *simple* name
// (the last dotted/`::` segment), so an edge `PaymentService.charge → save`
// chains into an edge whose caller is `save` or `Repo.save`.

export interface FlowEdge {
  caller: string;
  callee: string;
  file?: string;
  line?: number;
}

export type FlowDirection = 'callees' | 'callers' | 'both';

export interface TraceFlowOptions {
  direction?: FlowDirection;
  /** Maximum hops outward from the center symbol (default 3). */
  maxHops?: number;
  /** Hard cap on edges emitted, to bound graph explosion (default 2000). */
  maxEdges?: number;
}

export interface FlowHop {
  depth: number;
  direction: 'callees' | 'callers';
  edges: FlowEdge[];
}

export interface TraceFlowResult {
  center: string;
  direction: FlowDirection;
  maxHops: number;
  /** Edges discovered at each hop, ordered by depth then direction. */
  hops: FlowHop[];
  /** Every distinct symbol reached (by simple name), including the center. */
  nodes: string[];
  /** True if the edge cap was hit and the graph is incomplete. */
  truncated: boolean;
}

/** Last segment of a (possibly qualified) symbol — `A.B.c` → `c`, `X::y` → `y`. */
export function simpleName(symbol: string): string {
  const trimmed = symbol.trim();
  const parts = trimmed.split(/[.:#/]+/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : trimmed;
}

function pushTo(map: Map<string, FlowEdge[]>, key: string, edge: FlowEdge): void {
  const arr = map.get(key);
  if (arr) arr.push(edge);
  else map.set(key, [edge]);
}

/**
 * Walk the call graph outward from `start`. Downstream (`callees`) follows
 * caller→callee; upstream (`callers`) follows callee→caller; `both` does each
 * independently and merges the hops. Cycles terminate (each name expands once
 * per direction).
 */
export function traceFlow(
  edges: FlowEdge[],
  start: string,
  opts: TraceFlowOptions = {},
): TraceFlowResult {
  const direction = opts.direction ?? 'both';
  const maxHops = Math.max(1, opts.maxHops ?? 3);
  const maxEdges = Math.max(1, opts.maxEdges ?? 2000);

  const forward = new Map<string, FlowEdge[]>(); // simpleName(caller) → edges
  const reverse = new Map<string, FlowEdge[]>(); // simpleName(callee) → edges
  for (const e of edges) {
    pushTo(forward, simpleName(e.caller), e);
    pushTo(reverse, simpleName(e.callee), e);
  }

  const startName = simpleName(start);
  const nodes = new Set<string>([startName]);
  const hops: FlowHop[] = [];
  let edgeCount = 0;
  let truncated = false;

  const walk = (dir: 'callees' | 'callers'): void => {
    const adjacency = dir === 'callees' ? forward : reverse;
    let frontier = new Set<string>([startName]);
    const expanded = new Set<string>([startName]);
    for (let depth = 1; depth <= maxHops; depth++) {
      const next = new Set<string>();
      const hopEdges: FlowEdge[] = [];
      for (const name of frontier) {
        const adj = adjacency.get(name);
        if (!adj) continue;
        for (const e of adj) {
          if (edgeCount >= maxEdges) {
            truncated = true;
            break;
          }
          hopEdges.push(e);
          edgeCount++;
          const other = simpleName(dir === 'callees' ? e.callee : e.caller);
          nodes.add(other);
          if (!expanded.has(other)) next.add(other);
        }
        if (truncated) break;
      }
      if (hopEdges.length > 0) hops.push({ depth, direction: dir, edges: hopEdges });
      for (const n of next) expanded.add(n);
      frontier = next;
      if (truncated || frontier.size === 0) break;
    }
  };

  if (direction === 'callees' || direction === 'both') walk('callees');
  if (direction === 'callers' || direction === 'both') walk('callers');

  hops.sort((a, b) => a.depth - b.depth || a.direction.localeCompare(b.direction));
  return { center: start, direction, maxHops, hops, nodes: [...nodes], truncated };
}
