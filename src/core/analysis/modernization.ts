// Modernization analysis over a project's detected tech stack.
//
// Pure + offline: given a TechStack (from the ProjectStack collection, itself
// derived from manifests during ingest), flag runtimes and frameworks that are
// end-of-life, legacy, or materially behind, each with a recommendation. This
// is the "help with app modernization" capability — it grounds upgrade
// conversations in what's actually declared, not guesses.
//
// The rules are a curated, conservative knowledge table (current as of the
// ragolith release). They're exported and overridable so they can be tuned or
// kept fresh without touching the engine.

import type { TechStack } from '../types.js';

export type ModernizationSeverity = 'info' | 'warning' | 'high';

export interface ModernizationFinding {
  project: string;
  category: 'runtime' | 'framework';
  /** What the finding is about — "java", "React", "Spring Boot", … */
  subject: string;
  /** The detected version string, verbatim. */
  version: string;
  severity: ModernizationSeverity;
  finding: string;
  recommendation: string;
}

export interface ModernizationReport {
  project: string;
  findings: ModernizationFinding[];
  counts: Record<ModernizationSeverity, number>;
}

/** Pull the leading major-version integer from a loose version string. */
export function majorVersion(v: string): number | undefined {
  const m = v.match(/\d+/);
  return m ? Number(m[0]) : undefined;
}

type RuntimeRule = (
  major: number | undefined,
  raw: string,
) => Omit<ModernizationFinding, 'project' | 'category' | 'subject' | 'version'> | undefined;

/** Normalize a runtime key to a canonical form. */
function normRuntime(key: string): string {
  const k = key.toLowerCase();
  if (k === 'nodejs' || k === 'node') return 'node';
  if (k === 'java' || k === 'jdk' || k === 'jvm') return 'java';
  if (k === 'python' || k === 'py') return 'python';
  if (k === 'dotnet' || k === '.net' || k === 'netcore' || k === 'net') return 'dotnet';
  return k;
}

const RUNTIME_RULES: Record<string, RuntimeRule> = {
  java: (major) => {
    if (major === undefined) return undefined;
    if (major <= 8)
      return {
        severity: 'high',
        finding: `Java ${major} is past free public updates and several LTS releases behind`,
        recommendation: 'Upgrade to Java 21 (LTS); 17 at minimum',
      };
    if (major < 17)
      return {
        severity: 'warning',
        finding: `Java ${major} is non-LTS or aging`,
        recommendation: 'Move to a current LTS — Java 21 (or 17)',
      };
    return undefined;
  },
  node: (major) => {
    if (major === undefined) return undefined;
    if (major < 18)
      return {
        severity: 'high',
        finding: `Node ${major} is end-of-life — no security updates`,
        recommendation: 'Upgrade to an active LTS — Node 20 or 22',
      };
    if (major < 20)
      return {
        severity: 'warning',
        finding: `Node ${major} has reached or is nearing end of maintenance`,
        recommendation: 'Upgrade to an active LTS — Node 20 or 22',
      };
    return undefined;
  },
  python: (major, raw) => {
    if (major === undefined) return undefined;
    if (major < 3)
      return {
        severity: 'high',
        finding: `Python ${raw} is end-of-life (Python 2 sunset Jan 2020)`,
        recommendation: 'Upgrade to Python 3.11+',
      };
    // 3.x — look at minor for aging check.
    const minor = Number(raw.match(/3\.(\d+)/)?.[1] ?? '99');
    if (minor < 9)
      return {
        severity: 'warning',
        finding: `Python ${raw} is an aging 3.x and may be unsupported`,
        recommendation: 'Upgrade to Python 3.11+',
      };
    return undefined;
  },
  // .NET needs TFM-aware classification, not a bare major: "net48" is legacy
  // .NET Framework 4.8 (major would naively parse as 48), while "net8.0" is
  // current. Inspect the raw target-framework moniker.
  dotnet: (_major, raw) => classifyDotnetTfm(raw),
};

/**
 * Classify a .NET target-framework moniker. Legacy .NET Framework (`net48`,
 * `net472`, …) and .NET Core (`netcoreapp*`) are flagged; out-of-support modern
 * versions (`net5.0`–`net7.0`) warn; `net8.0`+ and `netstandard*` pass.
 */
function classifyDotnetTfm(
  raw: string,
): Omit<ModernizationFinding, 'project' | 'category' | 'subject' | 'version'> | undefined {
  const t = raw.toLowerCase().trim();
  if (t.startsWith('netstandard')) return undefined; // library target — not an app signal

  // .NET Framework: `net` + 2–3 digits, no dot (net20 … net481), or explicit.
  if (/^net[1-4]\d{0,2}$/.test(t) || t.startsWith('netframework')) {
    return {
      severity: 'high',
      finding: `Targets legacy .NET Framework (${raw}) — Windows-only, no longer the strategic runtime`,
      recommendation: 'Migrate to modern .NET (8 LTS); target .NET Standard for shared libraries',
    };
  }
  if (t.startsWith('netcoreapp')) {
    return {
      severity: 'high',
      finding: `.NET Core (${raw}) is end-of-life`,
      recommendation: 'Upgrade to .NET 8 (LTS)',
    };
  }
  const m = /^net(\d+)\.\d+/.exec(t);
  if (m) {
    const major = Number(m[1]);
    if (major < 8)
      return {
        severity: 'warning',
        finding: `.NET ${major} is out of support (only 8 LTS and newer are current)`,
        recommendation: 'Upgrade to .NET 8 (LTS)',
      };
  }
  return undefined;
}

interface FrameworkRule {
  /** Matches against the lowercased framework name. */
  match: (nameLower: string) => boolean;
  rule: (
    major: number | undefined,
    raw: string,
  ) => Omit<ModernizationFinding, 'project' | 'category' | 'subject' | 'version'> | undefined;
}

const FRAMEWORK_RULES: FrameworkRule[] = [
  {
    // manifest-scan labels legacy javax.* explicitly.
    match: (n) => n.includes('java ee') || n.includes('javax'),
    rule: () => ({
      severity: 'high',
      finding: 'Uses legacy javax.* Java EE APIs',
      recommendation: 'Migrate to Jakarta EE 9+ (jakarta.* namespace)',
    }),
  },
  {
    match: (n) => n === 'spring boot' || n === 'spring framework' || n.startsWith('spring web'),
    rule: (major) => {
      if (major === undefined) return undefined;
      if (major <= 1)
        return {
          severity: 'high',
          finding: `Spring ${major}.x is end-of-life`,
          recommendation: 'Upgrade to Spring Boot 3.x (Jakarta EE 9+, Java 17+)',
        };
      if (major === 2)
        return {
          severity: 'warning',
          finding: 'Spring Boot 2.x is past OSS end-of-life',
          recommendation: 'Upgrade to Spring Boot 3.x',
        };
      return undefined;
    },
  },
  {
    match: (n) => n === 'angular',
    rule: (major) => {
      if (major === undefined) return undefined;
      if (major <= 1)
        return {
          severity: 'high',
          finding: 'AngularJS (1.x) is end-of-life',
          recommendation: 'Migrate to modern Angular (2+) or another maintained framework',
        };
      if (major < 15)
        return {
          severity: 'warning',
          finding: `Angular ${major} is several majors behind`,
          recommendation: 'Upgrade toward the current Angular release',
        };
      return undefined;
    },
  },
  {
    match: (n) => n === 'react',
    rule: (major) => {
      if (major !== undefined && major < 17)
        return {
          severity: 'warning',
          finding: `React ${major} is several majors behind (current 18/19)`,
          recommendation: 'Upgrade to React 18+ (concurrent features, automatic batching)',
        };
      return undefined;
    },
  },
  {
    match: (n) => n === 'vue',
    rule: (major) => {
      if (major !== undefined && major < 3)
        return {
          severity: 'warning',
          finding: 'Vue 2 reached end-of-life (Dec 2023)',
          recommendation: 'Migrate to Vue 3',
        };
      return undefined;
    },
  },
  {
    match: (n) => n === 'junit 4',
    rule: () => ({
      severity: 'info',
      finding: 'JUnit 4 is in maintenance mode',
      recommendation: 'Adopt JUnit 5 (Jupiter) for new tests',
    }),
  },
  {
    match: (n) => n === 'express',
    rule: (major) => {
      if (major !== undefined && major < 4)
        return {
          severity: 'info',
          finding: `Express ${major} predates the 4.x line`,
          recommendation: 'Upgrade to Express 4+/5',
        };
      return undefined;
    },
  },
];

export interface ModernizationOptions {
  runtimeRules?: Record<string, RuntimeRule>;
  frameworkRules?: FrameworkRule[];
}

/** Analyze one project's tech stack for modernization findings. */
export function analyzeModernization(
  stack: TechStack,
  opts: ModernizationOptions = {},
): ModernizationReport {
  const runtimeRules = opts.runtimeRules ?? RUNTIME_RULES;
  const frameworkRules = opts.frameworkRules ?? FRAMEWORK_RULES;
  const findings: ModernizationFinding[] = [];

  for (const [key, raw] of Object.entries(stack.runtimes)) {
    const rule = runtimeRules[normRuntime(key)];
    if (!rule) continue;
    const partial = rule(majorVersion(raw), raw);
    if (partial) {
      findings.push({
        project: stack.project,
        category: 'runtime',
        subject: normRuntime(key),
        version: raw,
        ...partial,
      });
    }
  }

  for (const fw of stack.frameworks) {
    const nameLower = fw.name.toLowerCase();
    for (const fr of frameworkRules) {
      if (!fr.match(nameLower)) continue;
      const partial = fr.rule(majorVersion(fw.version), fw.version);
      if (partial) {
        findings.push({
          project: stack.project,
          category: 'framework',
          subject: fw.name,
          version: fw.version,
          ...partial,
        });
      }
      break; // first matching rule wins per framework
    }
  }

  const sevRank: Record<ModernizationSeverity, number> = { high: 0, warning: 1, info: 2 };
  findings.sort(
    (a, b) => sevRank[a.severity] - sevRank[b.severity] || a.subject.localeCompare(b.subject),
  );

  const counts: Record<ModernizationSeverity, number> = { high: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return { project: stack.project, findings, counts };
}
