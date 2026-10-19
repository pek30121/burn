#!/bin/sh
# READ-ONLY Git diagnosis before any synchronisation of a Replit checkout (or any clone). Run it in the Replit Shell:
#   sh scripts/replit/git-check.sh [target-branch]        (default target: main)
# It changes NO file, branch, commit or setting. The only network action is `git fetch` (it updates remote-tracking refs only).
# Verdicts: UP TO DATE / FAST-FORWARD / DIVERGED (merge needed, conflicts predicted yes/no) / STOP (rebase, merge or edits in progress).
TARGET="${1:-main}"
say() { printf '%s\n' "$*"; }
GITDIR="$(git rev-parse --git-dir 2>/dev/null)" || { say "STOP: not a git repository"; exit 2; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"
say "branch        : $BRANCH"
say "HEAD          : $HEAD_SHA"
say "pull.rebase   : $(git config --get pull.rebase || echo '(unset)')   <- must NOT be 'true'"
say "git version   : $(git --version)"

STOP=0
for f in rebase-merge rebase-apply; do [ -d "$GITDIR/$f" ] && { say "STOP: a rebase is in progress ($f). Finish or abort it first: git rebase --abort"; STOP=1; }; done
[ -f "$GITDIR/MERGE_HEAD" ] && { say "STOP: a merge is in progress. Finish it or abort it: git merge --abort"; STOP=1; }
[ -f "$GITDIR/CHERRY_PICK_HEAD" ] && { say "STOP: a cherry-pick is in progress"; STOP=1; }
DIRTY="$(git status --porcelain)"
[ -n "$DIRTY" ] && { say "STOP: uncommitted changes (commit or stash them first):"; say "$DIRTY"; STOP=1; }

git fetch origin --prune >/dev/null 2>&1 || say "WARNING: git fetch failed (network?) — the comparison below may be stale"
REMOTE="origin/$TARGET"
git rev-parse --verify -q "$REMOTE" >/dev/null || { say "STOP: $REMOTE does not exist"; exit 2; }
REMOTE_SHA="$(git rev-parse "$REMOTE")"
say "$REMOTE : $REMOTE_SHA"

AHEAD="$(git rev-list --count "$REMOTE..HEAD")"
BEHIND="$(git rev-list --count "HEAD..$REMOTE")"
say "local-only commits (not on $REMOTE): $AHEAD"
say "incoming commits (on $REMOTE, not here): $BEHIND"
if [ "$AHEAD" -gt 0 ]; then
  say "--- local-only commits (kept by a merge) ---"
  git log --format='  %h %an  %s' "$REMOTE..HEAD" | head -40
  say "--- files they touch ---"
  git diff --name-only "$REMOTE...HEAD" | sed 's/^/  /' | head -40
fi
if [ "$BEHIND" -gt 0 ]; then
  say "--- incoming commits ---"
  git log --format='  %h %an  %s' "HEAD..$REMOTE" | head -40
fi

[ "$STOP" -eq 1 ] && { say "VERDICT: STOP — fix the point above, then run this check again. Do not pull, sync or republish."; exit 1; }

if [ "$AHEAD" -eq 0 ] && [ "$BEHIND" -eq 0 ]; then say "VERDICT: UP TO DATE — nothing to do."; exit 0; fi
if [ "$AHEAD" -eq 0 ]; then say "VERDICT: FAST-FORWARD — Pull is safe: it only moves forward, no merge commit, no rebase."; exit 0; fi
if [ "$BEHIND" -eq 0 ]; then say "VERDICT: LOCAL IS AHEAD of $REMOTE — nothing to pull. (Do not push to $TARGET from Replit unless you mean to.)"; exit 0; fi

CONFLICTS="unknown (git too old for merge-tree --write-tree)"
if OUT="$(git merge-tree --write-tree --name-only HEAD "$REMOTE" 2>/dev/null)"; then CONFLICTS="no"; else
  [ -n "$OUT" ] && CONFLICTS="YES in: $(printf '%s\n' "$OUT" | sed -n '2,$p' | grep -v '^$' | grep -v '^Auto-merging' | grep -v '^CONFLICT' | sort -u | tr '\n' ' ')"
fi
say "VERDICT: DIVERGED ($AHEAD local, $BEHIND incoming). Use a MERGE, never a rebase: git merge --no-rebase --no-edit $REMOTE"
say "         predicted conflicts: $CONFLICTS"
say "         BEFORE merging, keep a safety branch:  git branch backup-before-sync-\$(date +%Y%m%d-%H%M)"
exit 0
