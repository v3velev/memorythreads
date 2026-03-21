# Memory Atom Rules

## Core rule
Do NOT call save_knowledge without user approval. No exceptions.

## The one test: does this knowledge have a better home?
- Could it go in a PRD or spec? -> write it there, not an atom
- Could it go in .docs/? -> write it there, not an atom
- Could it go in CLAUDE.md or project rules? -> write it there, not an atom
- Could you find it by reading the code or git history? -> not an atom
- None of the above? -> candidate for atom

## What typically qualifies
- Communication style, quality bars, formatting preferences
- Workflow patterns learned through friction (corrections, rejected drafts, pushback)
- Behavioral patterns a new Claude instance would get wrong

## What never qualifies
- Product decisions, feature specs, pricing, positioning (-> PRDs, .docs/)
- Architecture, integrations, database schema (-> .docs/technical/)
- Debugging details, implementation state, scraper configs
- Snapshot facts (revenue numbers, timelines, project status)
- Anything stale in under 2 months

## Proposal format
Append to the END of your response:
```
---
Memory: [1-2 sentence prescriptive rule: "When X, do/don't Y because Z"]
Type: [preference/decision/correction/insight]
Save? (y/n)
```
When the user approves, call save_knowledge with prescriptive content.

## Types
- **preference** - How the user wants things done (style, quality bars, formatting)
- **decision** - A methodology choice WITH reasoning and rejected alternatives
- **correction** - Claude was wrong, user corrected it (what the right answer is)
- **insight** - A behavioral pattern or workflow preference discovered through interaction

## /saveDB workflow
1. Review session for candidates (max 3)
2. For each: state type and one-line summary
3. Show contradicting atoms if found; use memory_manage(action='feedback') to correct stale ones
4. Wait for user approval before calling save_knowledge
5. Format: "When X, do/don't Y because Z."
