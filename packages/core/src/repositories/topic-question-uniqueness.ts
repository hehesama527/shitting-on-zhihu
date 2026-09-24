export const QUESTION_CLAIMED_STATUSES = ["processing", "accepted", "published"] as const;

type QuestionOwnerCandidate = {
  id: number;
  status: string;
  validityStatus?: string | null;
  accountId?: number | null;
  questionTitle?: string | null;
};

export function buildClaimedQuestionExclusionClause(candidateAlias: string) {
  return `AND NOT EXISTS (
    SELECT 1
    FROM topic_candidates claimed
    WHERE claimed.id <> ${candidateAlias}.id
      AND LOWER(SHA2(claimed.question_url, 256)) = LOWER(SHA2(${candidateAlias}.question_url, 256))
      AND (
        claimed.status IN ('processing', 'accepted', 'published')
        OR (
          claimed.status = 'new'
          AND claimed.id < ${candidateAlias}.id
        )
      )
  )`;
}

export function buildQuestionLockName(questionUrlHash: string) {
  return `zhq:${questionUrlHash.slice(0, 60)}`;
}

export function buildCrossAccountQuestionDuplicateReason(
  questionTitle: string,
  accountId?: number | null
) {
  if (accountId != null) {
    return `该问题已被账号 ${accountId} 占用，全站只回答一次：${questionTitle}`;
  }
  return `该问题已被其他账号占用，全站只回答一次：${questionTitle}`;
}

export function pickQuestionOwner<T extends QuestionOwnerCandidate>(
  candidates: T[],
  excludeCandidateId?: number | null
): T | null {
  const others = candidates.filter((candidate) => candidate.id !== excludeCandidateId);
  const claimed = others
    .filter((candidate) => (QUESTION_CLAIMED_STATUSES as readonly string[]).includes(candidate.status))
    .sort((left, right) => left.id - right.id);
  if (claimed[0]) {
    return claimed[0];
  }

  const earlierOpen = others
    .filter((candidate) => candidate.status === "new")
    .sort((left, right) => left.id - right.id);

  const firstOpen = earlierOpen[0];
  if (!firstOpen) {
    return null;
  }
  if (excludeCandidateId != null && firstOpen.id >= excludeCandidateId) {
    return null;
  }
  return firstOpen;
}
