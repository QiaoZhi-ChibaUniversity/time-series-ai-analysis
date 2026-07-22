/// <reference lib="webworker" />

import { executeAnalysisPlan, type AnalysisPlan } from "@/lib/analysis-dsl";
import {
  aggregateTemporal,
  detectOutliers,
  rankRelationships,
  type DataRow,
  type TemporalGranularity,
} from "@/lib/data-agent-tools";

type WorkerTask =
  | { id: string; type: "rank_relationships"; rows: DataRow[]; numericColumns: string[]; targetColumn: string }
  | { id: string; type: "detect_outliers"; rows: DataRow[]; column: string }
  | { id: string; type: "aggregate_temporal"; rows: DataRow[]; timeColumn: string; valueColumn: string; granularity: TemporalGranularity }
  | { id: string; type: "execute_plan"; rows: DataRow[]; columns: string[]; plan: AnalysisPlan };

self.onmessage = (event: MessageEvent<WorkerTask>) => {
  const task = event.data;
  try {
    const result =
      task.type === "rank_relationships"
        ? rankRelationships(task.rows, task.numericColumns, task.targetColumn)
        : task.type === "detect_outliers"
        ? detectOutliers(task.rows, task.column)
        : task.type === "aggregate_temporal"
        ? aggregateTemporal(task.rows, task.timeColumn, task.valueColumn, task.granularity)
        : executeAnalysisPlan(task.rows, task.columns, task.plan);
    self.postMessage({ id: task.id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id: task.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
