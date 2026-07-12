import { useSyncExternalStore } from "react";
import { getAppFeatures, listConnections } from "./api";

let planningConnectorsEnabled: boolean | null = null;
let probe: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function publish(value: boolean) {
  planningConnectorsEnabled = value;
  listeners.forEach((listener) => listener());
  return value;
}

export async function probePlanningConnectors(): Promise<boolean> {
  if (planningConnectorsEnabled !== null) return planningConnectorsEnabled;
  if (probe) return probe;

  probe = getAppFeatures()
    .then((features) => publish(features.planning_connectors_enabled))
    .catch(async () => {
      try {
        await listConnections();
        return publish(true);
      } catch {
        // Older/partially deployed backends expose the gate as a 503 on /connections.
        return publish(false);
      }
    })
    .finally(() => {
      probe = null;
    });
  return probe;
}

export function usePlanningConnectorsEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => planningConnectorsEnabled ?? false,
    () => false,
  );
}

export function resetFeaturesForTests(): void {
  planningConnectorsEnabled = null;
  probe = null;
  listeners.clear();
}
