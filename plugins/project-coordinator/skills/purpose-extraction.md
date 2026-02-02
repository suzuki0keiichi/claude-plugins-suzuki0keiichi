---
name: Purpose Extraction
description: This skill should be used when the user asks to "clarify the goal", "what's the purpose", "why are we doing this", "extract the purpose", or mentions purpose clarification, goal alignment, or plan-purpose mismatch. Helps crystallize vague intentions into clear, actionable objectives.
version: 1.1.0
---

# Purpose Extraction Skill

Purpose extraction: uncover the true objectives behind plans and actions. The expertise lies in asking the right questions to crystallize vague intentions into clear, actionable purposes.

## When to Use

- Plan exists but no explicit purpose documented
- User describes tasks without stating the goal
- Purpose and planned actions seem misaligned
- Vague objectives need crystallization
- Plan mode outputs need purpose grounding

**Core Philosophy:**
- **Plans are "what"** — Purpose is "why"
- **Without clear purpose**, even perfect execution leads nowhere
- **Misaligned purpose** causes wasted effort and frustration
- **Your job**: Ensure the "why" is crystal clear before work begins

## When Invoked

### 1. Assess the Situation

Read available context:
- Check for existing `.claude/project-coordinator/purpose.md`
- Read any `plan.md` or plan mode output
- Review recent conversation for implicit goals

### 2. Reverse-Engineer Purpose from Plan

When only a plan exists, work backwards:

**Ask yourself:**
1. What outcome does this plan achieve when complete?
2. What problem does it solve?
3. Who benefits and how?
4. What would failure look like? (inverse reveals purpose)

**Pattern Recognition:**
| Plan Pattern | Likely Purpose Category |
|--------------|------------------------|
| Refactoring tasks | Maintainability, tech debt, performance |
| New features | User needs, business requirements |
| Bug fixes | Reliability, user experience |
| Documentation | Knowledge transfer, onboarding |
| Testing tasks | Quality assurance, confidence |

### 3. Detect Purpose-Action Misalignment

**Red Flags (MUST ask user):**
- Plan steps don't logically lead to stated goal
- Multiple unrelated objectives mixed together
- Success criteria undefined or unmeasurable
- "Improve X" without specific metrics
- Actions that contradict the stated purpose

**Example Misalignments:**
- "Improve performance" → plan adds features (misaligned)
- "Simplify codebase" → plan adds abstractions (potentially misaligned)
- "Fix bug" → plan rewrites entire module (scope creep)

### 4. Clarification Protocol

**Ask user when:**
- Purpose cannot be confidently inferred
- Multiple plausible interpretations exist
- Purpose and plan seem misaligned
- Success criteria are vague

**Question Framework:**

1. **Outcome Question**: "When this is complete, what will be different?"
2. **Problem Question**: "What problem or pain point does this address?"
3. **Success Question**: "How will you know this succeeded?"
4. **Scope Question**: "What is explicitly NOT part of this goal?"
5. **Stakeholder Question**: "Who else is affected? Do they agree on this goal?"

**Question Quality Rules:**
- One question at a time (avoid overwhelming)
- Offer concrete options when possible
- Never assume — always verify
- Rephrase user's answer back to confirm understanding

### 5. Formulate Purpose Statement

**Good Purpose Structure:**
```
## Purpose

**Objective:** [One sentence: what we're achieving]

**Context:** [Why now? What triggered this?]

**Success Criteria:**
- [ ] [Specific, measurable criterion 1]
- [ ] [Specific, measurable criterion 2]

**Out of Scope:**
- [Explicitly excluded item]
```

**Purpose Quality Checklist:**
- [ ] Answers "why" not just "what"
- [ ] Single clear objective (not multiple goals)
- [ ] Measurable success criteria
- [ ] Scope boundaries defined
- [ ] Achievable within reasonable effort
- [ ] **Stakeholder alignment**: All affected parties agree on this purpose?

### 6. Output

Once purpose is clarified:

1. **Write to `.claude/project-coordinator/purpose.md`** (if project-coordinator is in use)
2. **Report back** with the crystallized purpose
3. **Flag any remaining concerns** about plan-purpose alignment

## Key Practices

**Patience Over Speed:**
- Don't rush to conclusions
- Better to ask one more question than proceed with wrong purpose
- Ambiguity now = wasted effort later

**User is the Authority:**
- You extract and clarify, not decide
- Present options, let user choose
- Their "why" matters more than your inference

**Precision in Language:**
- Avoid vague terms: "improve", "better", "fix"
- Demand specifics: "reduce latency by 50%", "handle edge case X"
- If user uses vague terms, ask for specifics

**Scope Discipline:**
- One purpose per project
- Multiple goals = multiple projects
- ⚠️ Why: Multiple objectives in one project = failure probability **multiplies** (not adds). Split if possible.
- Suggest splitting if scope is too broad
