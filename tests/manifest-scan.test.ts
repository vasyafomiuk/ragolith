import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectTechStack,
  parseBuildGradle,
  parseCsproj,
  parsePackageJson,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt,
} from '../src/core/manifest-scan.js';

describe('parsePackageJson', () => {
  it('extracts deps, devDeps, and runtime engines', () => {
    const result = parsePackageJson(
      JSON.stringify({
        dependencies: { react: '^18.2.0', express: '4.18.2' },
        devDependencies: { typescript: '5.4.0', jest: '29.0.0' },
        engines: { node: '>=20' },
      }),
    );
    assert.ok(result);
    const names = result.deps.map((d) => d.name).sort();
    assert.deepEqual(names, ['express', 'jest', 'react', 'typescript']);
    assert.equal(result.runtimes['node'], '>=20');
  });

  it('returns undefined on invalid JSON', () => {
    assert.equal(parsePackageJson('{not json'), undefined);
  });

  it('handles an empty package.json', () => {
    const result = parsePackageJson('{}');
    assert.ok(result);
    assert.equal(result.deps.length, 0);
    assert.deepEqual(result.runtimes, {});
  });
});

describe('parsePomXml', () => {
  it('extracts dependencies as groupId:artifactId with versions', () => {
    const pom = `
      <project>
        <properties>
          <java.version>17</java.version>
        </properties>
        <dependencies>
          <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter</artifactId>
            <version>2.7.18</version>
          </dependency>
          <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>5.10.0</version>
            <scope>test</scope>
          </dependency>
        </dependencies>
      </project>
    `;
    const result = parsePomXml(pom);
    assert.ok(result);
    assert.equal(result.deps.length, 2);
    const spring = result.deps.find(
      (d) => d.name === 'org.springframework.boot:spring-boot-starter',
    );
    assert.equal(spring?.version, '2.7.18');
    assert.equal(result.runtimes['java'], '17');
  });

  it('stores literal property placeholder when version uses a property reference', () => {
    const pom = `
      <project>
        <dependencies>
          <dependency>
            <groupId>org.example</groupId>
            <artifactId>thing</artifactId>
            <version>\${thing.version}</version>
          </dependency>
        </dependencies>
      </project>
    `;
    const result = parsePomXml(pom);
    assert.ok(result);
    assert.equal(result.deps[0]?.version, '${thing.version}');
  });
});

describe('parseBuildGradle', () => {
  it('parses both Groovy and Kotlin DSL forms', () => {
    const gradle = `
      plugins { id 'java' }
      sourceCompatibility = '17'
      dependencies {
        implementation 'org.springframework.boot:spring-boot-starter:2.7.18'
        api("io.micronaut:micronaut-core:4.0.0")
        testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
      }
    `;
    const result = parseBuildGradle(gradle);
    assert.ok(result);
    const names = result.deps.map((d) => d.name).sort();
    assert.deepEqual(names, [
      'io.micronaut:micronaut-core',
      'org.junit.jupiter:junit-jupiter',
      'org.springframework.boot:spring-boot-starter',
    ]);
    assert.equal(result.runtimes['java'], '17');
  });

  it('reads java version from JavaLanguageVersion.of(...)', () => {
    const gradle = `
      java {
        toolchain {
          languageVersion = JavaLanguageVersion.of(21)
        }
      }
    `;
    const result = parseBuildGradle(gradle);
    assert.ok(result);
    assert.equal(result.runtimes['java'], '21');
  });
});

describe('parseRequirementsTxt', () => {
  it('handles ==, >=, no-version, and comments', () => {
    const txt = `
      # comment
      django==4.2.0
      requests>=2.31.0
      fastapi
      -r other.txt
      git+https://github.com/foo/bar.git
    `;
    const result = parseRequirementsTxt(txt);
    assert.ok(result);
    const names = result.deps.map((d) => d.name).sort();
    assert.deepEqual(names, ['django', 'fastapi', 'requests']);
    assert.equal(result.deps.find((d) => d.name === 'django')?.version, '==4.2.0');
    assert.equal(result.deps.find((d) => d.name === 'fastapi')?.version, 'unknown');
  });
});

describe('parsePyprojectToml', () => {
  it('extracts PEP 621 dependencies + requires-python', () => {
    const toml = `
[project]
name = "thing"
requires-python = ">=3.10"
dependencies = [
  "fastapi>=0.100",
  "pydantic==2.5.0",
  "requests",
]
    `;
    const result = parsePyprojectToml(toml);
    assert.ok(result);
    const names = result.deps.map((d) => d.name).sort();
    assert.deepEqual(names, ['fastapi', 'pydantic', 'requests']);
    assert.equal(result.runtimes['python'], '>=3.10');
  });

  it('extracts Poetry deps and python pin', () => {
    const toml = `
[tool.poetry.dependencies]
python = "^3.11"
django = "^4.2"
celery = "5.3.0"

[tool.poetry.dev-dependencies]
pytest = "*"
    `;
    const result = parsePyprojectToml(toml);
    assert.ok(result);
    const names = result.deps.map((d) => d.name).sort();
    // dev-dependencies isn't parsed by the poetry block; that's fine for v1.
    assert.deepEqual(names, ['celery', 'django']);
    assert.equal(result.runtimes['python'], '^3.11');
  });
});

describe('parseCsproj', () => {
  it('extracts PackageReference entries and TargetFramework', () => {
    const csproj = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.App" Version="8.0.0" />
    <PackageReference Include="Serilog" Version="3.1.1" />
    <PackageReference Include="MediatR">
      <Version>12.2.0</Version>
    </PackageReference>
  </ItemGroup>
</Project>
    `;
    const result = parseCsproj(csproj);
    assert.ok(result);
    const map = new Map(result.deps.map((d) => [d.name, d.version]));
    assert.equal(map.get('Microsoft.AspNetCore.App'), '8.0.0');
    assert.equal(map.get('Serilog'), '3.1.1');
    assert.equal(map.get('MediatR'), '12.2.0');
    assert.equal(result.runtimes['dotnet'], 'net8.0');
  });

  it('detects WPF / WinForms / Native AOT via MSBuild properties', () => {
    const csproj = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0-windows</TargetFramework>
    <OutputType>WinExe</OutputType>
    <UseWPF>true</UseWPF>
    <UseWindowsForms>true</UseWindowsForms>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
    `;
    const result = parseCsproj(csproj)!;
    const names = result.deps.map((d) => d.name);
    assert.ok(names.includes('@dotnet/wpf'));
    assert.ok(names.includes('@dotnet/winforms'));
    assert.ok(names.includes('@dotnet/aot'));
  });

  it('detects Blazor / ASP.NET Core via SDK and reads TargetFrameworks (plural)', () => {
    const web = parseCsproj(
      '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup></Project>',
    )!;
    assert.ok(web.deps.some((d) => d.name === '@dotnet/aspnetcore'));
    assert.equal(web.runtimes['dotnet'], 'net8.0'); // first of the plural list

    const blazor = parseCsproj('<Project Sdk="Microsoft.NET.Sdk.Razor"></Project>')!;
    assert.ok(blazor.deps.some((d) => d.name === '@dotnet/blazor'));
  });
});

describe('detectTechStack — end-to-end on a temp repo', () => {
  it('aggregates root + subPath manifests and maps frameworks via the allowlist', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ragolith-stack-'));
    try {
      // Root: Spring Boot Maven project
      await writeFile(
        join(tmp, 'pom.xml'),
        `<project>
          <properties><java.version>17</java.version></properties>
          <dependencies>
            <dependency>
              <groupId>org.springframework.boot</groupId>
              <artifactId>spring-boot-starter</artifactId>
              <version>3.2.0</version>
            </dependency>
          </dependencies>
        </project>`,
      );
      // subPath: a Node service
      await mkdir(join(tmp, 'frontend'));
      await writeFile(
        join(tmp, 'frontend', 'package.json'),
        JSON.stringify({
          dependencies: { react: '18.2.0', next: '14.0.0' },
          engines: { node: '>=20' },
        }),
      );

      const stack = await detectTechStack(tmp, ['frontend'], 'demo', 'abc123');
      assert.equal(stack.project, 'demo');
      assert.equal(stack.commit_sha, 'abc123');
      assert.deepEqual(stack.languages.sort(), ['java', 'javascript']);
      assert.deepEqual(stack.build_tools.sort(), ['maven', 'npm']);
      assert.equal(stack.runtimes['java'], '17');
      assert.equal(stack.runtimes['node'], '>=20');

      const frameworkNames = stack.frameworks.map((f) => f.name).sort();
      assert.ok(frameworkNames.includes('Spring Boot'));
      assert.ok(frameworkNames.includes('React'));
      assert.ok(frameworkNames.includes('Next.js'));

      // Sources are correctly attributed to their manifest paths.
      const reactEntry = stack.frameworks.find((f) => f.name === 'React');
      assert.equal(reactEntry?.source, 'frontend/package.json');
      const springEntry = stack.frameworks.find((f) => f.name === 'Spring Boot');
      assert.equal(springEntry?.source, 'pom.xml');

      // Manifests are recorded for traceability.
      assert.equal(stack.manifests.length, 2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty stack when no manifests are found', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ragolith-stack-empty-'));
    try {
      const stack = await detectTechStack(tmp, undefined, 'nothing');
      assert.equal(stack.project, 'nothing');
      assert.deepEqual(stack.languages, []);
      assert.deepEqual(stack.build_tools, []);
      assert.deepEqual(stack.frameworks, []);
      assert.deepEqual(stack.manifests, []);
      assert.ok(stack.detected_at);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
