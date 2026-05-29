// Manifest scanner — detects a project's tech stack by reading build files.
//
// Walks the repo root and each declared subPath, looks for package.json,
// pom.xml, build.gradle[.kts], requirements.txt, pyproject.toml, and *.csproj,
// extracts dependencies + runtime versions, and maps known dependency names
// onto friendly framework labels via a curated allowlist.
//
// Parsers are intentionally regex-based to keep the dependency surface zero.
// They handle the common shapes (Maven `<dependency>` blocks, Gradle
// `implementation 'group:artifact:version'`, PEP-621 + Poetry, etc.); when a
// shape isn't recognized — variable interpolation, BOM-managed versions,
// dependency block macros — the entry is stored with version `'unknown'`
// rather than skipped, so the LLM still sees the dependency.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedFramework, ManifestType, TechStack } from './types.js';

// ---------------- Framework allowlist ----------------

interface AllowlistEntry {
  manifest: ManifestType;
  match: string;
  framework: string;
}

// Curated mapping of "raw dependency name as it appears in the manifest" →
// "friendly framework label". Order doesn't matter; matching is exact.
// Gradle entries are looked up against the maven list (same coords); poetry
// is looked up against the pip list (same package names).
const ALLOWLIST: AllowlistEntry[] = [
  // ----- npm -----
  { manifest: 'npm', match: 'react', framework: 'React' },
  { manifest: 'npm', match: 'react-dom', framework: 'React' },
  { manifest: 'npm', match: 'next', framework: 'Next.js' },
  { manifest: 'npm', match: 'vue', framework: 'Vue' },
  { manifest: 'npm', match: '@angular/core', framework: 'Angular' },
  { manifest: 'npm', match: 'svelte', framework: 'Svelte' },
  { manifest: 'npm', match: '@sveltejs/kit', framework: 'SvelteKit' },
  { manifest: 'npm', match: 'express', framework: 'Express' },
  { manifest: 'npm', match: 'fastify', framework: 'Fastify' },
  { manifest: 'npm', match: 'koa', framework: 'Koa' },
  { manifest: 'npm', match: '@nestjs/core', framework: 'NestJS' },
  { manifest: 'npm', match: 'prisma', framework: 'Prisma' },
  { manifest: 'npm', match: 'typeorm', framework: 'TypeORM' },
  { manifest: 'npm', match: 'graphql', framework: 'GraphQL' },
  { manifest: 'npm', match: 'jest', framework: 'Jest' },
  { manifest: 'npm', match: 'vitest', framework: 'Vitest' },
  { manifest: 'npm', match: 'typescript', framework: 'TypeScript' },
  { manifest: 'npm', match: 'webpack', framework: 'webpack' },
  { manifest: 'npm', match: 'vite', framework: 'Vite' },

  // ----- maven (gradle uses these via effectiveManifest()) -----
  {
    manifest: 'maven',
    match: 'org.springframework.boot:spring-boot-starter',
    framework: 'Spring Boot',
  },
  { manifest: 'maven', match: 'org.springframework:spring-core', framework: 'Spring Framework' },
  { manifest: 'maven', match: 'org.springframework:spring-web', framework: 'Spring Web' },
  { manifest: 'maven', match: 'org.hibernate:hibernate-core', framework: 'Hibernate' },
  { manifest: 'maven', match: 'jakarta.servlet:jakarta.servlet-api', framework: 'Jakarta EE' },
  {
    manifest: 'maven',
    match: 'javax.servlet:javax.servlet-api',
    framework: 'Java EE (legacy javax.*)',
  },
  { manifest: 'maven', match: 'org.junit.jupiter:junit-jupiter', framework: 'JUnit 5' },
  { manifest: 'maven', match: 'junit:junit', framework: 'JUnit 4' },
  { manifest: 'maven', match: 'org.mockito:mockito-core', framework: 'Mockito' },
  { manifest: 'maven', match: 'org.apache.kafka:kafka-clients', framework: 'Kafka' },
  { manifest: 'maven', match: 'io.quarkus:quarkus-core', framework: 'Quarkus' },
  { manifest: 'maven', match: 'io.micronaut:micronaut-core', framework: 'Micronaut' },
  { manifest: 'maven', match: 'com.fasterxml.jackson.core:jackson-databind', framework: 'Jackson' },
  { manifest: 'maven', match: 'org.apache.logging.log4j:log4j-core', framework: 'Log4j 2' },
  { manifest: 'maven', match: 'log4j:log4j', framework: 'Log4j 1.x (legacy)' },
  { manifest: 'maven', match: 'org.slf4j:slf4j-api', framework: 'SLF4J' },

  // ----- pip (poetry uses these via effectiveManifest()) -----
  { manifest: 'pip', match: 'django', framework: 'Django' },
  { manifest: 'pip', match: 'flask', framework: 'Flask' },
  { manifest: 'pip', match: 'fastapi', framework: 'FastAPI' },
  { manifest: 'pip', match: 'sqlalchemy', framework: 'SQLAlchemy' },
  { manifest: 'pip', match: 'pydantic', framework: 'Pydantic' },
  { manifest: 'pip', match: 'pandas', framework: 'pandas' },
  { manifest: 'pip', match: 'numpy', framework: 'NumPy' },
  { manifest: 'pip', match: 'torch', framework: 'PyTorch' },
  { manifest: 'pip', match: 'tensorflow', framework: 'TensorFlow' },
  { manifest: 'pip', match: 'scikit-learn', framework: 'scikit-learn' },
  { manifest: 'pip', match: 'pytest', framework: 'pytest' },
  { manifest: 'pip', match: 'celery', framework: 'Celery' },
  { manifest: 'pip', match: 'requests', framework: 'requests' },

  // ----- nuget -----
  { manifest: 'nuget', match: 'Microsoft.AspNetCore.App', framework: 'ASP.NET Core' },
  { manifest: 'nuget', match: 'Microsoft.EntityFrameworkCore', framework: 'Entity Framework Core' },
  { manifest: 'nuget', match: 'Microsoft.Extensions.Hosting', framework: '.NET Generic Host' },
  { manifest: 'nuget', match: 'MediatR', framework: 'MediatR' },
  { manifest: 'nuget', match: 'Serilog', framework: 'Serilog' },
  { manifest: 'nuget', match: 'AutoMapper', framework: 'AutoMapper' },
  { manifest: 'nuget', match: 'Newtonsoft.Json', framework: 'Newtonsoft.Json' },
  { manifest: 'nuget', match: 'xunit', framework: 'xUnit' },
  { manifest: 'nuget', match: 'NUnit', framework: 'NUnit' },
  { manifest: 'nuget', match: 'Moq', framework: 'Moq' },
  // Desktop / native / UI client frameworks — package-based.
  { manifest: 'nuget', match: 'Avalonia', framework: 'Avalonia' },
  { manifest: 'nuget', match: 'Microsoft.Maui.Controls', framework: '.NET MAUI' },
  {
    manifest: 'nuget',
    match: 'Microsoft.AspNetCore.Components.WebAssembly',
    framework: 'Blazor WebAssembly',
  },
  { manifest: 'nuget', match: 'Microsoft.WindowsAppSDK', framework: 'WinUI 3' },
  { manifest: 'nuget', match: 'CommunityToolkit.Mvvm', framework: 'MVVM Toolkit' },
  // Synthetic markers emitted by parseCsproj for MSBuild props / SDK (not real
  // packages). The `@dotnet/*` names never collide with NuGet package ids.
  { manifest: 'nuget', match: '@dotnet/wpf', framework: 'WPF' },
  { manifest: 'nuget', match: '@dotnet/winforms', framework: 'WinForms' },
  { manifest: 'nuget', match: '@dotnet/maui', framework: '.NET MAUI' },
  { manifest: 'nuget', match: '@dotnet/aot', framework: 'Native AOT' },
  { manifest: 'nuget', match: '@dotnet/blazor', framework: 'Blazor' },
  { manifest: 'nuget', match: '@dotnet/aspnetcore', framework: 'ASP.NET Core' },
  { manifest: 'nuget', match: '@dotnet/worker', framework: 'Worker Service' },
];

// Gradle uses Maven coordinates; treat as equivalent for lookup. Same for
// Poetry → pip (bare package names).
function effectiveManifest(t: ManifestType): ManifestType {
  if (t === 'gradle') return 'maven';
  if (t === 'poetry') return 'pip';
  return t;
}

function friendlyFramework(rawName: string, manifest: ManifestType): string | undefined {
  const lookup = effectiveManifest(manifest);
  for (const e of ALLOWLIST) {
    if (e.manifest === lookup && e.match === rawName) return e.framework;
  }
  return undefined;
}

// ---------------- Parsers ----------------

interface RawDependency {
  name: string;
  version: string;
}

interface ParseResult {
  deps: RawDependency[];
  runtimes: Record<string, string>;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export function parsePackageJson(content: string): ParseResult | undefined {
  let data: PackageJson | undefined;
  try {
    data = JSON.parse(content) as PackageJson;
  } catch {
    return undefined;
  }
  const deps: RawDependency[] = [];
  for (const map of [data.dependencies, data.devDependencies, data.peerDependencies]) {
    if (!map) continue;
    for (const [name, version] of Object.entries(map)) {
      deps.push({ name, version });
    }
  }
  const runtimes: Record<string, string> = {};
  if (data.engines?.['node']) runtimes['node'] = data.engines['node'];
  if (data.engines?.['npm']) runtimes['npm'] = data.engines['npm'];
  return { deps, runtimes };
}

export function parsePomXml(content: string): ParseResult | undefined {
  const deps: RawDependency[] = [];
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m: RegExpExecArray | null;
  while ((m = depRe.exec(content)) !== null) {
    const inner = m[1] ?? '';
    const groupId = /<groupId>\s*([^<]+?)\s*<\/groupId>/.exec(inner)?.[1];
    const artifactId = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(inner)?.[1];
    const version = /<version>\s*([^<]+?)\s*<\/version>/.exec(inner)?.[1];
    if (groupId && artifactId) {
      deps.push({ name: `${groupId}:${artifactId}`, version: version ?? 'unknown' });
    }
  }
  const runtimes: Record<string, string> = {};
  const javaVer =
    /<java\.version>\s*([^<]+?)\s*<\/java\.version>/.exec(content)?.[1] ??
    /<maven\.compiler\.source>\s*([^<]+?)\s*<\/maven\.compiler\.source>/.exec(content)?.[1] ??
    /<maven\.compiler\.release>\s*([^<]+?)\s*<\/maven\.compiler\.release>/.exec(content)?.[1];
  if (javaVer) runtimes['java'] = javaVer;
  return { deps, runtimes };
}

export function parseBuildGradle(content: string): ParseResult | undefined {
  // Match both Groovy and Kotlin DSL forms:
  //   implementation 'g:a:v'             implementation("g:a:v")
  //   api "g:a:v"                        testImplementation("g:a:v")
  const deps: RawDependency[] = [];
  const configs = [
    'implementation',
    'api',
    'compile',
    'compileOnly',
    'runtimeOnly',
    'testImplementation',
    'testCompile',
    'testRuntimeOnly',
    'kapt',
    'annotationProcessor',
  ];
  const cfgGroup = configs.join('|');
  const re = new RegExp(`(?:${cfgGroup})\\s*\\(?\\s*["']([^:"']+):([^:"']+):([^"']+)["']`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const group = m[1];
    const artifact = m[2];
    const version = m[3];
    if (group && artifact) {
      deps.push({ name: `${group}:${artifact}`, version: version ?? 'unknown' });
    }
  }
  const runtimes: Record<string, string> = {};
  const javaToolchain =
    /JavaLanguageVersion\.of\((\d+)\)/.exec(content)?.[1] ??
    /sourceCompatibility\s*=?\s*['"]?([\d.]+)['"]?/.exec(content)?.[1] ??
    /targetCompatibility\s*=?\s*['"]?([\d.]+)['"]?/.exec(content)?.[1];
  if (javaToolchain) runtimes['java'] = javaToolchain;
  return { deps, runtimes };
}

export function parseRequirementsTxt(content: string): ParseResult | undefined {
  const deps: RawDependency[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0]?.trim();
    if (!line) continue;
    // Skip -r/-e includes, URL installs, hash specifications.
    if (line.startsWith('-') || line.includes('://')) continue;
    const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:([<>=!~]=?)\s*([^;\s]+))?/.exec(line);
    if (!m) continue;
    const name = m[1];
    const op = m[2];
    const ver = m[3];
    if (!name) continue;
    deps.push({ name, version: ver ? `${op ?? ''}${ver}` : 'unknown' });
  }
  return { deps, runtimes: {} };
}

export function parsePyprojectToml(content: string): ParseResult | undefined {
  // Handle two common shapes without a TOML library:
  //   [project] dependencies = ["pkg>=1.0", ...]                (PEP 621)
  //   [tool.poetry.dependencies] pkg = "^1.0"                   (Poetry)
  const deps: RawDependency[] = [];
  const runtimes: Record<string, string> = {};

  // PEP 621 array (also catches multi-line).
  const pep621Match = /\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/.exec(content);
  if (pep621Match) {
    const arr = pep621Match[1] ?? '';
    for (const sm of arr.matchAll(/["']([^"']+)["']/g)) {
      const spec = sm[1] ?? '';
      const parsed = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*([<>=!~]=?[^;,]+)?/.exec(spec);
      if (!parsed) continue;
      const name = parsed[1];
      const ver = parsed[2];
      if (!name) continue;
      deps.push({ name, version: ver?.trim() ?? 'unknown' });
    }
    const pyMatch = /requires-python\s*=\s*["']([^"']+)["']/.exec(content);
    if (pyMatch?.[1]) runtimes['python'] = pyMatch[1];
  }

  // Poetry block.
  const poetryBlock = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(content);
  if (poetryBlock) {
    const block = poetryBlock[1] ?? '';
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
      if (!kv) continue;
      const name = kv[1];
      const rawVal = kv[2] ?? '';
      if (!name) continue;
      if (name === 'python') {
        const vm = /["']([^"']+)["']/.exec(rawVal);
        if (vm?.[1]) runtimes['python'] = vm[1];
        continue;
      }
      const vm = /["']([^"']+)["']/.exec(rawVal);
      deps.push({ name, version: vm?.[1] ?? 'unknown' });
    }
  }

  return { deps, runtimes };
}

export function parseCsproj(content: string): ParseResult | undefined {
  const deps: RawDependency[] = [];
  const seen = new Set<string>();

  // Pass 1 — self-closing: <PackageReference Include="X" Version="Y" />
  for (const m of content.matchAll(/<PackageReference\s+([^>]+?)\s*\/>/g)) {
    const attrs = m[1] ?? '';
    const name = /\bInclude\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    if (!name || seen.has(name)) continue;
    const version = /\bVersion\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? 'unknown';
    deps.push({ name, version });
    seen.add(name);
  }

  // Pass 2 — open form: <PackageReference Include="X">…<Version>Y</Version>…</PackageReference>
  // The final `[^/\s>]` inside the attrs group forces the last char before `>`
  // to be a real attribute char, so self-closing tags (which end in ` />`) can
  // never match this pattern and trigger the lazy `</PackageReference>` to
  // gobble a later element's content.
  for (const m of content.matchAll(
    /<PackageReference\s+((?:[^>])*?[^/\s>])\s*>([\s\S]*?)<\/PackageReference>/g,
  )) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const name = /\bInclude\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    if (!name || seen.has(name)) continue;
    const version =
      /\bVersion\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ??
      /<Version>\s*([^<]+?)\s*<\/Version>/.exec(inner)?.[1] ??
      'unknown';
    deps.push({ name, version });
    seen.add(name);
  }

  const runtimes: Record<string, string> = {};
  // Singular <TargetFramework> or the first entry of plural <TargetFrameworks>.
  const tfm =
    /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/.exec(content)?.[1] ??
    /<TargetFrameworks>\s*([^<;]+?)\s*[;<]/.exec(content)?.[1];
  if (tfm) runtimes['dotnet'] = tfm;

  // MSBuild feature flags + SDK aren't NuGet packages, but they're the only
  // reliable signal for WPF/WinForms/MAUI/Native-AOT/Blazor. Emit synthetic
  // `@dotnet/*` deps that the allowlist maps to friendly framework names.
  const featVersion = tfm ?? 'enabled';
  const addFeature = (name: string): void => {
    if (seen.has(name)) return;
    deps.push({ name, version: featVersion });
    seen.add(name);
  };
  if (/<UseWPF>\s*true\s*<\/UseWPF>/i.test(content)) addFeature('@dotnet/wpf');
  if (/<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(content))
    addFeature('@dotnet/winforms');
  if (/<UseMaui>\s*true\s*<\/UseMaui>/i.test(content)) addFeature('@dotnet/maui');
  if (/<PublishAot>\s*true\s*<\/PublishAot>/i.test(content)) addFeature('@dotnet/aot');

  const sdk = /<Project[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(content)?.[1] ?? '';
  if (/Microsoft\.NET\.Sdk\.Web/i.test(sdk)) addFeature('@dotnet/aspnetcore');
  if (/Microsoft\.NET\.Sdk\.Worker/i.test(sdk)) addFeature('@dotnet/worker');
  if (/Microsoft\.NET\.Sdk\.Razor|BlazorWebAssembly/i.test(sdk)) addFeature('@dotnet/blazor');

  return { deps, runtimes };
}

// ---------------- Aggregation ----------------

interface ManifestSpec {
  filename: string | RegExp;
  type: ManifestType;
  language: string;
  parse: (content: string) => ParseResult | undefined;
}

const MANIFEST_SPECS: ManifestSpec[] = [
  { filename: 'package.json', type: 'npm', language: 'javascript', parse: parsePackageJson },
  { filename: 'pom.xml', type: 'maven', language: 'java', parse: parsePomXml },
  { filename: 'build.gradle', type: 'gradle', language: 'java', parse: parseBuildGradle },
  { filename: 'build.gradle.kts', type: 'gradle', language: 'kotlin', parse: parseBuildGradle },
  { filename: 'requirements.txt', type: 'pip', language: 'python', parse: parseRequirementsTxt },
  { filename: 'pyproject.toml', type: 'poetry', language: 'python', parse: parsePyprojectToml },
  { filename: /\.csproj$/i, type: 'nuget', language: 'csharp', parse: parseCsproj },
];

interface ParsedManifest {
  path: string;
  type: ManifestType;
  language: string;
  deps: RawDependency[];
  runtimes: Record<string, string>;
}

async function readManifestsInDir(dir: string, relBase: string): Promise<ParsedManifest[]> {
  const out: ParsedManifest[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const spec of MANIFEST_SPECS) {
    const matches =
      typeof spec.filename === 'string'
        ? entries.includes(spec.filename)
          ? [spec.filename]
          : []
        : entries.filter((f) => (spec.filename as RegExp).test(f));
    for (const file of matches) {
      const fullPath = join(dir, file);
      const content = await readFile(fullPath, 'utf-8').catch(() => undefined);
      if (content === undefined) continue;
      const parsed = spec.parse(content);
      if (!parsed) continue;
      out.push({
        path: relBase ? `${relBase}/${file}` : file,
        type: spec.type,
        language: spec.language,
        deps: parsed.deps,
        runtimes: parsed.runtimes,
      });
    }
  }
  return out;
}

/**
 * Scan a repo (root + optional subPaths) for build manifests and return an
 * aggregated TechStack record. Pure filesystem I/O — does no Weaviate writes.
 *
 * Resilient: any manifest that fails to parse is silently skipped; a project
 * with zero recognizable manifests returns an empty stack with just `project`,
 * `detected_at`, and (if provided) `commit_sha` set — useful as evidence that
 * detection ran and found nothing, vs. "never scanned."
 */
export async function detectTechStack(
  repoPath: string,
  subPaths: string[] | undefined,
  projectName: string,
  commitSha?: string,
): Promise<TechStack> {
  const locations: { dir: string; relBase: string }[] = [{ dir: repoPath, relBase: '' }];
  for (const sub of subPaths ?? []) {
    if (!sub) continue;
    const dir = join(repoPath, sub);
    if (existsSync(dir)) locations.push({ dir, relBase: sub });
  }

  const all: ParsedManifest[] = [];
  for (const loc of locations) {
    all.push(...(await readManifestsInDir(loc.dir, loc.relBase)));
  }

  const languages = new Set<string>();
  const buildTools = new Set<ManifestType>();
  const runtimes: Record<string, string> = {};
  const frameworks: DetectedFramework[] = [];

  for (const mf of all) {
    languages.add(mf.language);
    buildTools.add(mf.type);
    for (const [k, v] of Object.entries(mf.runtimes)) {
      // First non-empty wins so the root manifest takes precedence over subPaths.
      if (!(k in runtimes)) runtimes[k] = v;
    }
    for (const dep of mf.deps) {
      const friendly = friendlyFramework(dep.name, mf.type);
      if (friendly) frameworks.push({ name: friendly, version: dep.version, source: mf.path });
    }
  }

  const result: TechStack = {
    project: projectName,
    languages: Array.from(languages).sort(),
    build_tools: Array.from(buildTools).sort(),
    runtimes,
    frameworks,
    manifests: all.map((m) => ({ path: m.path, type: m.type })),
    detected_at: new Date().toISOString(),
  };
  if (commitSha) result.commit_sha = commitSha;
  return result;
}
