import type { MemberCatalog, PeriodResult, PovSliceResult } from "./api";

export function getMemberName(
  catalog: MemberCatalog | undefined,
  dimensionId: string,
  memberId: string,
): string {
  const dimension = catalog?.[dimensionId];
  if (Array.isArray(dimension)) {
    const member = dimension.find((entry) =>
      typeof entry === "string" ? entry === memberId : entry.id === memberId);
    return typeof member === "string" ? member : member?.name ?? memberId;
  }
  return dimension?.[memberId] ?? memberId;
}

export function setPovMember(
  pov: Record<string, string>,
  dimensionId: string,
  memberId: string,
): Record<string, string> {
  const next = { ...pov };
  if (memberId) next[dimensionId] = memberId;
  else delete next[dimensionId];
  return next;
}

export function applyPovSlice(
  current: { pl: Record<string, number>; periods?: PeriodResult[] },
  slice: PovSliceResult,
): { pl: Record<string, number>; periods: PeriodResult[] | undefined } {
  return {
    pl: slice.pl ?? current.pl,
    periods: slice.periods ?? current.periods,
  };
}
