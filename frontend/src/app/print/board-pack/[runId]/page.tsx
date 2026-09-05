type BoardPackData = {
  scenario: { scenario_id: string; name: string | null; nl_input: string };
  output: {
    aggregate?: Record<string, number>;
    base_pl?: Record<string, number>;
    fidelity?: { score?: number; ready?: boolean };
  };
  narrative: string | null;
  run_timestamp: string;
  company: string | null;
  denomination: { currency: string; unit: string };
  parameters: Array<{
    extracted_name: string;
    mapped_variable_id: string;
    scenario_value: number;
    owner_name: string | null;
    owner_user_id: string | null;
    source_citation: string | null;
    rationale: string | null;
    effective_from: string | null;
    review_status: string;
    confidence_score: number | null;
  }>;
  manifest: {
    row_hash: string;
    model_hash: string;
    scenario_version_id: string;
    created_at: string;
    engine: Record<string, unknown>;
    mc: Record<string, unknown> | null;
  } | null;
};

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

function metricLabel(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default async function BoardPackPrintPage({
  params,
  searchParams,
}: {
  params: { runId: string };
  searchParams: { token?: string };
}) {
  const api =
    process.env.BOARD_PACK_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:4000";
  const token = searchParams.token || "";
  const response = await fetch(
    `${api}/api/v1/board-pack-print/${encodeURIComponent(params.runId)}?token=${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    return <main className="p-8">Board pack unavailable: {response.status}</main>;
  }
  const data = (await response.json()) as BoardPackData;
  const scenario = data.output.aggregate ?? {};
  const base = data.output.base_pl ?? {};
  const metrics = Object.keys(scenario);
  const max = Math.max(1, ...metrics.map((id) => Math.abs(scenario[id] ?? 0)));
  const unit = `${data.denomination.currency} ${data.denomination.unit}`;

  return (
    <main data-board-pack-ready="true" className="board-pack">
      <style>{`
        @page { size: A4; margin: 10mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #1d1d1b; font-family: Arial, sans-serif; }
        .board-pack { font-size: 10pt; }
        .page { min-height: 270mm; page-break-after: always; padding: 4mm; position: relative; }
        .page:last-child { page-break-after: auto; }
        h1 { font-size: 27pt; margin: 0 0 8mm; }
        h2 { border-bottom: 3px solid #86bc25; font-size: 18pt; padding-bottom: 2mm; }
        h3 { font-size: 12pt; margin: 6mm 0 2mm; }
        .muted { color: #666; }
        .hash { overflow-wrap: anywhere; font-family: monospace; font-size: 7pt; }
        .footer { position: absolute; bottom: 2mm; left: 4mm; right: 4mm; border-top: 1px solid #ccc; padding-top: 2mm; font-size: 7pt; color: #666; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #1d1d1b; color: white; text-align: left; }
        th, td { border: 1px solid #d0d0ce; padding: 2mm; vertical-align: top; }
        .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
        .kpi { border: 1px solid #d0d0ce; border-top: 4px solid #86bc25; padding: 4mm; }
        .bar-row { display: grid; grid-template-columns: 42mm 1fr 34mm; gap: 3mm; align-items: center; margin: 3mm 0; }
        .bar-track { height: 6mm; background: #eee; }
        .bar { height: 100%; background: #86bc25; }
        .status { text-transform: capitalize; font-weight: bold; }
      `}</style>

      <section className="page">
        <div style={{ marginTop: "42mm" }}>
          <p className="muted">{data.company || "Scenario Modeling"}</p>
          <h1>{data.scenario.name || "Scenario Board Pack"}</h1>
          <p style={{ fontSize: "14pt", maxWidth: "150mm" }}>{data.scenario.nl_input}</p>
          <p className="muted">Run: {new Date(data.run_timestamp).toLocaleString("en-IN")}</p>
          <p className="muted">Figures in {unit}</p>
        </div>
        <div className="footer hash">Manifest: {data.manifest?.row_hash || "Legacy run — unavailable"}</div>
      </section>

      <section className="page">
        <h2>Executive Summary</h2>
        <p>{data.narrative || "Narrative not generated for this run."}</p>
        <div className="kpis">
          {metrics.slice(0, 6).map((id) => (
            <div className="kpi" key={id}>
              <div className="muted">{metricLabel(id)}</div>
              <strong style={{ fontSize: "16pt" }}>{number.format(scenario[id])}</strong>
              <div>{unit}</div>
            </div>
          ))}
        </div>
        <h3>P&amp;L movement</h3>
        {metrics.slice(0, 10).map((id) => (
          <div className="bar-row" key={id}>
            <span>{metricLabel(id)}</span>
            <div className="bar-track">
              <div className="bar" style={{ width: `${Math.abs(scenario[id]) / max * 100}%` }} />
            </div>
            <span>{number.format(scenario[id])}</span>
          </div>
        ))}
        <div className="footer hash">Manifest: {data.manifest?.row_hash || "Legacy run — unavailable"}</div>
      </section>

      <section className="page">
        <h2>P&amp;L Detail</h2>
        <table>
          <thead>
            <tr><th>Metric</th><th>Base</th><th>Scenario</th><th>Delta</th><th>Unit</th></tr>
          </thead>
          <tbody>
            {metrics.map((id) => (
              <tr key={id}>
                <td>{metricLabel(id)}</td>
                <td>{number.format(base[id] ?? 0)}</td>
                <td>{number.format(scenario[id])}</td>
                <td>{number.format(scenario[id] - (base[id] ?? 0))}</td>
                <td>{unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="footer hash">Manifest: {data.manifest?.row_hash || "Legacy run — unavailable"}</div>
      </section>

      <section className="page">
        <h2>Assumptions Book</h2>
        <table>
          <thead>
            <tr>
              <th>Assumption</th><th>Value</th><th>Owner</th><th>Source / Rationale</th><th>Effective</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.parameters.map((parameter) => (
              <tr key={parameter.mapped_variable_id}>
                <td>{parameter.extracted_name}</td>
                <td>{number.format(Number(parameter.scenario_value))}</td>
                <td>{parameter.owner_name || parameter.owner_user_id || "—"}</td>
                <td>
                  {parameter.source_citation || "—"}
                  {parameter.rationale ? <><br /><span className="muted">{parameter.rationale}</span></> : null}
                </td>
                <td>{parameter.effective_from?.slice(0, 10) || "—"}</td>
                <td className="status">{parameter.review_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="footer hash">Manifest: {data.manifest?.row_hash || "Legacy run — unavailable"}</div>
      </section>

      <section className="page">
        <h2>Provenance &amp; Confidence</h2>
        <table>
          <tbody>
            <tr><th>Manifest hash</th><td className="hash">{data.manifest?.row_hash || "Legacy run — unavailable"}</td></tr>
            <tr><th>Model hash</th><td className="hash">{data.manifest?.model_hash || "—"}</td></tr>
            <tr><th>Scenario version</th><td>{data.manifest?.scenario_version_id || "—"}</td></tr>
            <tr><th>Run timestamp</th><td>{data.manifest?.created_at ? new Date(data.manifest.created_at).toLocaleString("en-IN") : "—"}</td></tr>
            <tr><th>Engine</th><td className="hash">{data.manifest ? JSON.stringify(data.manifest.engine) : "—"}</td></tr>
            <tr><th>Monte Carlo</th><td>{data.manifest?.mc ? JSON.stringify(data.manifest.mc) : "Not applicable to deterministic run"}</td></tr>
            <tr><th>Fidelity</th><td>{data.output.fidelity ? JSON.stringify(data.output.fidelity) : "—"}</td></tr>
          </tbody>
        </table>
        <h3>Assumption citations</h3>
        <ul>
          {data.parameters.map((parameter) => (
            <li key={parameter.mapped_variable_id}>
              {parameter.extracted_name}: {parameter.source_citation || "No citation supplied"}; confidence{" "}
              {parameter.confidence_score == null ? "—" : `${number.format(parameter.confidence_score * 100)}%`}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
