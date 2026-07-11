/** Visually hidden data table for chart accessibility (screen readers). */

export interface ChartDataTableProps {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}

export function ChartDataTable({ caption, columns, rows }: ChartDataTableProps) {
  if (rows.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col} scope="col">
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
