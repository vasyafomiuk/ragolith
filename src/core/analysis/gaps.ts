// Gap analysis over the SDLC artifact graph.
//
// Pure, deterministic, embedding-free: given the full set of indexed
// artifacts, it traverses the link graph and surfaces traceability holes —
// requirements nobody implemented, implementations nobody tested, decisions
// that never landed, tests that trace to nothing, and links that point into
// the void. This is the "find gaps in the implementation" capability.
//
// It works purely over `links`, so its quality is a function of how well the
// source artifacts are cross-referenced. An optional semantic pass (run in the
// CLI with a live client) can suggest the closest code for an unlinked
// requirement — but the graph analysis here needs no Weaviate.

import type { SdlcArtifact, SdlcArtifactKind } from '../types.js';

export type GapKind =
  | 'unimplemented_requirement'
  | 'untested_requirement'
  | 'unimplemented_decision'
  | 'orphan_test'
  | 'dangling_link';

export type GapSeverity = 'info' | 'warning' | 'high';

export interface Gap {
  kind: GapKind;
  severity: GapSeverity;
  artifact_id: string;
  artifact_kind: SdlcArtifactKind;
  title: string;
  project: string;
  source: string;
  /** Human-readable explanation of why this is flagged. */
  detail: string;
}

export interface GapReport {
  gaps: Gap[];
  counts: Record<GapKind, number>;
  /** Total artifacts analyzed and a breakdown by kind. */
  totals: { artifacts: number; byKind: Record<string, number> };
}

export interface GapOptions {
  /** Kinds treated as "requirements" for implementation/testing checks. */
  requirementKinds?: SdlcArtifactKind[];
  /** Statuses (lowercased) that mark a decision as committed. */
  acceptedStatuses?: string[];
}

const DEFAULT_REQUIREMENT_KINDS: SdlcArtifactKind[] = ['requirement', 'story', 'feature', 'epic'];

const DEFAULT_ACCEPTED_STATUSES = ['accepted', 'approved', 'done', 'committed', 'final'];

/** A link target is a code reference (not another artifact) when prefixed. */
export function isCodeRef(target: string): boolean {
  return /^(repo|symbol|file|code):/i.test(target);
}

const IMPLEMENTS_OUT = new Set(['implemented_by']);
const IMPLEMENTS_IN = new Set(['implements']);
const TEST_OUT = new Set(['tested_by']);
const TEST_IN = new Set(['tests']);

/**
 * Analyze a set of artifacts for traceability gaps. The input should be the
 * full corpus (or a project-scoped slice) so cross-references resolve.
 */
export function analyzeGaps(artifacts: SdlcArtifact[], opts: GapOptions = {}): GapReport {
  const reqKinds = new Set(opts.requirementKinds ?? DEFAULT_REQUIREMENT_KINDS);
  const acceptedStatuses = new Set(
    (opts.acceptedStatuses ?? DEFAULT_ACCEPTED_STATUSES).map((s) => s.toLowerCase()),
  );

  const knownIds = new Set(artifacts.map((a) => a.artifact_id));

  // Build incoming-link index: targetId → set of rels pointing at it.
  const incoming = new Map<string, Set<string>>();
  for (const a of artifacts) {
    for (const link of a.links) {
      if (isCodeRef(link.target)) continue;
      let rels = incoming.get(link.target);
      if (!rels) {
        rels = new Set();
        incoming.set(link.target, rels);
      }
      rels.add(link.rel);
    }
  }

  const hasRel = (a: SdlcArtifact, outRels: Set<string>, inRels: Set<string>): boolean => {
    if (a.links.some((l) => outRels.has(l.rel))) return true;
    const inc = incoming.get(a.artifact_id);
    if (inc) for (const r of inc) if (inRels.has(r)) return true;
    return false;
  };

  const gaps: Gap[] = [];
  const byKind: Record<string, number> = {};

  for (const a of artifacts) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

    const base = {
      artifact_id: a.artifact_id,
      artifact_kind: a.kind,
      title: a.title,
      project: a.project,
      source: a.source,
    };

    // Dangling links — a non-code target that names no known artifact.
    for (const link of a.links) {
      if (isCodeRef(link.target)) continue;
      if (!knownIds.has(link.target)) {
        gaps.push({
          ...base,
          kind: 'dangling_link',
          severity: 'warning',
          detail: `link "${link.rel} → ${link.target}" points to an unknown artifact (typo, or not yet indexed)`,
        });
      }
    }

    const implemented = hasRel(a, IMPLEMENTS_OUT, IMPLEMENTS_IN);
    const tested = hasRel(a, TEST_OUT, TEST_IN);

    if (reqKinds.has(a.kind)) {
      if (!implemented) {
        gaps.push({
          ...base,
          kind: 'unimplemented_requirement',
          severity: 'high',
          detail:
            'no implementation link (implemented_by / incoming implements) — may be unbuilt or untraced',
        });
      } else if (!tested) {
        gaps.push({
          ...base,
          kind: 'untested_requirement',
          severity: 'warning',
          detail: 'implemented but no test link (tested_by / incoming tests)',
        });
      }
    }

    if (a.kind === 'decision' && a.status && acceptedStatuses.has(a.status.toLowerCase())) {
      if (!implemented) {
        gaps.push({
          ...base,
          kind: 'unimplemented_decision',
          severity: 'warning',
          detail: `decision is "${a.status}" but has no implementation link`,
        });
      }
    }

    if (a.kind === 'test_case') {
      const tracesToReq = hasRel(a, TEST_IN, TEST_OUT); // tests (out) or tested_by (in)
      if (!tracesToReq) {
        gaps.push({
          ...base,
          kind: 'orphan_test',
          severity: 'info',
          detail: 'test case links to no requirement (tests / incoming tested_by)',
        });
      }
    }
  }

  const counts: Record<GapKind, number> = {
    unimplemented_requirement: 0,
    untested_requirement: 0,
    unimplemented_decision: 0,
    orphan_test: 0,
    dangling_link: 0,
  };
  for (const g of gaps) counts[g.kind]++;

  // Stable ordering: severity desc, then kind, then id.
  const sevRank: Record<GapSeverity, number> = { high: 0, warning: 1, info: 2 };
  gaps.sort(
    (x, y) =>
      sevRank[x.severity] - sevRank[y.severity] ||
      x.kind.localeCompare(y.kind) ||
      x.artifact_id.localeCompare(y.artifact_id),
  );

  return {
    gaps,
    counts,
    totals: { artifacts: artifacts.length, byKind },
  };
}
