const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-(\d+)$/;

/** Sort Jira issue keys by project and numeric issue number. Other ids retain lexical order. */
export function compareTicketIds(a: string, b: string): number {
  const aKey = ISSUE_KEY.exec(a);
  const bKey = ISSUE_KEY.exec(b);

  if (aKey && bKey) {
    const projectOrder = compareText(aKey[1], bKey[1]);
    if (projectOrder !== 0) return projectOrder;

    const aNumber = BigInt(aKey[2]);
    const bNumber = BigInt(bKey[2]);
    if (aNumber < bNumber) return -1;
    if (aNumber > bNumber) return 1;
  }

  return compareText(a, b);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
