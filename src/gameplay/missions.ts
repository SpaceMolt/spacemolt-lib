// TODO: mission turn-in orchestration belongs here once exact objective shapes are pinned.

export interface MissionObjective {
  complete?: boolean;
}

export function missionComplete(objectives: readonly MissionObjective[] | null | undefined): boolean {
  if (!objectives || objectives.length === 0) return false;
  return objectives.every((o) => o.complete === true);
}
