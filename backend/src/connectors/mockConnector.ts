/**
 * In-memory planning connector fed by fixtures — CI and demo mode.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConnectionCredentials,
  FactPage,
  FactQuery,
  FactRow,
  PlanningConnector,
  PlanningModelMetadata,
  PlanningModelSummary,
} from "./types.js";

const DEFAULT_FIXTURE = join(process.cwd(), "src/tests/fixtures/sac_snapshot_small.json");

interface FixtureFile extends PlanningModelMetadata {
  facts: FactRow[];
}

function loadFixture(path?: string): FixtureFile {
  const p = path || DEFAULT_FIXTURE;
  return JSON.parse(readFileSync(p, "utf8")) as FixtureFile;
}

export class MockConnector implements PlanningConnector {
  readonly provider = "mock" as const;
  private fixture: FixtureFile;

  constructor(creds?: ConnectionCredentials) {
    this.fixture = loadFixture(creds?.fixturePath);
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: "Mock connector ready" };
  }

  async listModels(): Promise<PlanningModelSummary[]> {
    return [
      {
        id: this.fixture.modelId,
        name: this.fixture.modelName,
        description: "Fixture-backed demo model",
      },
    ];
  }

  async getModelMetadata(modelId: string): Promise<PlanningModelMetadata> {
    if (modelId !== this.fixture.modelId && modelId !== "default") {
      // Still return the fixture — single-model mock
    }
    const { facts: _f, ...meta } = this.fixture;
    return meta;
  }

  async *getModelData(modelId: string, query: FactQuery): AsyncIterable<FactPage> {
    void modelId;
    let rows = [...this.fixture.facts];

    if (query.versionMemberId) {
      rows = rows.filter((r) => r.memberKey.split("|").includes(query.versionMemberId!));
    }
    if (query.timeMemberIds && query.timeMemberIds.length > 0) {
      const set = new Set(query.timeMemberIds);
      rows = rows.filter((r) => r.memberKey.split("|").some((p) => set.has(p)));
    }
    if (query.measureIds && query.measureIds.length > 0) {
      const set = new Set(query.measureIds);
      rows = rows.filter((r) => set.has(r.measureId));
    }
    if (query.filters) {
      for (const [, memberIds] of Object.entries(query.filters)) {
        if (!memberIds.length) continue;
        const set = new Set(memberIds);
        rows = rows.filter((r) => r.memberKey.split("|").some((p) => set.has(p)));
      }
    }

    const pageSize = query.pageSize ?? 500;
    for (let i = 0; i < rows.length; i += pageSize) {
      const page = rows.slice(i, i + pageSize);
      yield {
        rows: page,
        nextPageToken: i + pageSize < rows.length ? String(i + pageSize) : undefined,
      };
    }
  }
}

/** Load fixture metadata+facts for tests without constructing a connector. */
export function loadMockFixture(path?: string): FixtureFile {
  return loadFixture(path);
}
