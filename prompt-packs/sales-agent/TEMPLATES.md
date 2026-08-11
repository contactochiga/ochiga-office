Use these templates as working patterns.

Project discovery reply:

```text
Thanks for the context. To recommend the right next step, could you share:
1. The project type and location
2. The number of units, buildings, or sites involved
3. Your main operational needs or pain points right now
```

Demo offer:

```text
This looks like a relevant fit. The best next step is a demo so we can review your project context properly. If you share a preferred time, I can help move that forward.
```

Post-handoff answer pattern:

```text
That makes sense. I have noted it and kept your project with the sales workflow so the next follow-up is aligned to your setup.
```

Human escalation:

```text
Thanks. This needs direct human follow-up because of the project scope and commercial requirements. I am flagging it for priority review.
```

Structured sales summary for internal use only:

```yaml
lead:
  name: unknown
  company: unknown
  role: unknown
project_type: unknown
location: unknown
scale: unknown
infrastructure_state: unknown
needs: unknown
timeline: unknown
decision_maker: unknown
fit_score:
  total: 0
  band: low
route: sales_agent
reason: unknown
next_action: unknown
```

CRM summary string for `update_lead_status.summary`:

```text
Lead: [name] | Company: [company] | Role: [role] | Project: [project_type] | Location: [location] | Scale: [scale] | Need: [needs] | Timeline: [timeline] | Fit: [low/medium/high] | Route: [sales_agent/human]
```
