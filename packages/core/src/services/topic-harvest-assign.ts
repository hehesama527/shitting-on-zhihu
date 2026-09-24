export const SHARED_TOPIC_BATCH_SIZE = 10;

export type TopicDemand = {
  accountId: number;
  neededCount: number;
};

export type TopicHolder = {
  id: number;
  accountId: number;
};

export function planTopicAssignments(input: {
  candidates: TopicHolder[];
  demand: TopicDemand[];
}): Array<{ candidateId: number; fromAccountId: number; toAccountId: number }> {
  const demandAccounts = input.demand.filter((item) => item.neededCount > 0);
  if (!demandAccounts.length || !input.candidates.length) {
    return [];
  }

  const owned = new Map<number, number[]>();
  for (const candidate of input.candidates) {
    const list = owned.get(candidate.accountId) ?? [];
    list.push(candidate.id);
    owned.set(candidate.accountId, list);
  }

  const needed = new Map(demandAccounts.map((item) => [item.accountId, item.neededCount]));
  const movable = collectSurplusCandidates(owned, needed);
  const assignments: Array<{ candidateId: number; fromAccountId: number; toAccountId: number }> = [];
  const rotation = demandAccounts.map((item) => item.accountId);

  assignRoundRobin({
    movable,
    owned,
    rotation,
    shouldTake: (accountId) => (owned.get(accountId)?.length ?? 0) < (needed.get(accountId) ?? 0),
    assignments
  });

  assignRoundRobin({
    movable,
    owned,
    rotation,
    shouldTake: () => true,
    assignments
  });

  return assignments;
}

export function shouldHarvestSharedTopicBatch(input: {
  totalOpenCandidates: number;
  totalDemand: number;
  emptyDemandAccounts: number;
  batchSize?: number;
}) {
  if (input.totalDemand <= 0) {
    return false;
  }
  if (input.emptyDemandAccounts > 0) {
    return true;
  }
  return input.totalOpenCandidates < Math.max(input.batchSize ?? SHARED_TOPIC_BATCH_SIZE, input.totalDemand);
}

function collectSurplusCandidates(owned: Map<number, number[]>, needed: Map<number, number>) {
  const movable: Array<{ id: number; fromAccountId: number }> = [];
  for (const [accountId, ids] of owned) {
    const keepCount = needed.get(accountId) ?? 0;
    for (const id of ids.slice(keepCount)) {
      movable.push({ id, fromAccountId: accountId });
    }
  }
  return movable;
}

function assignRoundRobin(input: {
  movable: Array<{ id: number; fromAccountId: number }>;
  owned: Map<number, number[]>;
  rotation: number[];
  shouldTake: (accountId: number) => boolean;
  assignments: Array<{ candidateId: number; fromAccountId: number; toAccountId: number }>;
}) {
  if (!input.rotation.length) {
    return;
  }

  let cursor = 0;
  let idlePasses = 0;

  while (input.movable.length && idlePasses < input.rotation.length) {
    const toAccountId = input.rotation[cursor % input.rotation.length];
    cursor += 1;
    if (!input.shouldTake(toAccountId)) {
      idlePasses += 1;
      continue;
    }

    const index = input.movable.findIndex((item) => item.fromAccountId !== toAccountId);
    if (index < 0) {
      idlePasses += 1;
      continue;
    }

    const next = input.movable.splice(index, 1)[0];
    if (!next) {
      break;
    }

    input.assignments.push({
      candidateId: next.id,
      fromAccountId: next.fromAccountId,
      toAccountId
    });
    input.owned.set(
      next.fromAccountId,
      (input.owned.get(next.fromAccountId) ?? []).filter((id) => id !== next.id)
    );
    input.owned.set(toAccountId, [...(input.owned.get(toAccountId) ?? []), next.id]);
    idlePasses = 0;
  }
}
