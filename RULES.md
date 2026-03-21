# Memory Atom Rules

## Core rule
Do NOT call save_knowledge without user approval. No exceptions.

## What to save (atoms are about the PERSON, not the project)
- How the user communicates, reviews, decides, and prefers things done
- Quality bars and standards (content depth, formatting, tone)
- Workflow preferences learned through friction (corrections, rejected drafts, pushback)
- Behavioral patterns that would cause a new Claude instance to make mistakes

## What NOT to save (these belong in .docs/ or code)
- Product/strategic decisions, feature specs, pricing, positioning
- Architecture choices, integration decisions, database schema
- Anything already in CLAUDE.md, .docs/, or discoverable from code
- Debugging details, implementation state, scraper configs
- Tool configurations (discoverable from skill system)
- Snapshot facts (revenue numbers, project status, timelines)
- Anything that will be stale in under 2 months

## Pre-proposal checklist (all 4 must pass)
1. **Person not project** - Is this about how the user works, not what the project does?
2. **Not documented** - Could I find this by reading the codebase or .docs? (must be no)
3. **Prevents mistakes** - Would a new Claude instance get this wrong without the atom?
4. **Durable** - Will this still be true in 2+ months?

## Proposal format
Before proposing, call recall_context to check for existing atoms on the same topic.
Append to the END of your response:
```
---
Memory: [1-2 sentence prescriptive rule: "When X, do/don't Y because Z"]
Type: [preference/decision/correction/insight]
Gates: [person not project] [not in docs] [prevents mistake] [durable]
Related atoms: none | reinforces #N | contradicts #N
Save? (y/n)
```
When the user approves, call save_knowledge with prescriptive content.

## Types
- **preference** - How the user wants things done (style, quality bars, formatting)
- **decision** - A methodology choice WITH reasoning and rejected alternatives
- **correction** - Claude was wrong, user corrected it (what the right answer is)
- **insight** - A behavioral pattern or workflow preference discovered through interaction

## /saveDB workflow
1. Run recall_context with broad query to see existing atoms
2. Identify candidates (max 3 per session)
3. For each: state type, summary, and which gates it passes
4. Show contradicting atoms if found; use memory_manage(action='feedback') to correct stale ones
5. Wait for user approval before calling save_knowledge
6. Decisions must include reasoning + alternatives. Format: "When X, do/don't Y because Z."
