# Debate Template

Fill in {placeholders} with project-specific content.

```
---
name: debate
description: >
  Resolves contradictions between review perspectives for {project_name}.
  Takes contradicting finding pairs and produces reasoned compromises.
---

# Debate: Contradiction Resolution

## Input

You receive pairs of contradicting findings from different perspectives.

## Process

For each contradiction pair:

1. Read both findings and their evidence
2. Check knowledge-base for relevant context that might resolve the contradiction
3. Determine which finding has stronger evidence
4. Produce a resolution:
   - If one is clearly correct: adopt it, explain why the other was wrong
   - If both have merit: produce a merged finding with combined evidence
   - If unresolvable: keep both, note the disagreement for human review

## Output Format

### Contradiction: [Finding A] vs [Finding B]
- **Resolution**: [merged finding / adopted A / adopted B / unresolved]
- **Reasoning**: [why this resolution was chosen]
- **Original findings preserved**: yes
```
